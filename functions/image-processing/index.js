// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const S3 = new AWS.S3({signatureVersion: 'v4', httpOptions: {agent: new https.Agent({keepAlive: true})}});
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.cacheBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.cacheTTL;
const SECRET_KEY = process.env.secretKey;
const LOG_TIMING = process.env.logTiming;

const ImageFormat = {
    JPG: {Name: 'jpg', Format: 'jpeg', ContentType: 'image/jpeg', SupportQuality: true},
    JPEG: {Name: 'jpeg', Format: 'jpeg', ContentType: 'image/jpeg', SupportQuality: true},
    PNG: {Name: 'png', Format: 'png', ContentType: 'image/png', SupportQuality: false},
    WEBP: {Name: 'webp', Format: 'webp', ContentType: 'image/webp', SupportQuality: true},
    GIF: {Name: 'gif', Format: 'gif', ContentType: 'image/gif', SupportQuality: false},
    TIF: {Name: 'tif', Format: 'tiff', ContentType: 'image/tiff', SupportQuality: true},
    TIFF: {Name: 'tiff', Format: 'tiff', ContentType: 'image/tiff', SupportQuality: true},
    AVIF: {Name: 'avif', Format: 'avif', ContentType: 'image/avif', SupportQuality: true},
    SVG: {Name: 'svg', Format: 'svg', ContentType: 'image/svg+xml', SupportQuality: false},
}

exports.handler = async (event) => {
    // 验证密码
    const secret = event.headers['x-origin-secret-header'];
    if (!secret || !(secret === SECRET_KEY)) {
        return newError('Request unauthorized', event);
    }
    // 判断请求方法
    const requestContext = event.requestContext;
    if (!requestContext || !requestContext.http || !(requestContext.http.method === 'GET')) {
        return newError('Only GET method is supported', event);
    }
    // 取出请求路径, 例如 /images/rio/1.jpeg/format=auto,width=100 或 /images/rio/1.jpeg/original 的原始路径为 /images/rio/1.jpeg
    const requestPath = requestContext.http.path;
    console.log(`==> GET ${requestPath}`)
    const imagePathArray = requestPath.split('/');
    // 最后一个元素出栈 format=auto,width=100 或 original
    const operationsPrefix = imagePathArray.pop();
    // 获取原始路径 images/rio/1.jpg
    imagePathArray.shift();
    const originalImagePath = imagePathArray.join('/');
    // 缓存 key
    const cacheKey = originalImagePath + '/' + operationsPrefix;
    // 起始时间
    let startTime = performance.now();
    // 下载源文件
    let originFileObj;
    try {
        originFileObj = await downloadFile(originalImagePath);
    } catch (error) {
        return newError('Could not download origin file from S3', error);
    } finally {
        startTime = printTiming('Download origin file', startTime)
    }
    const originContentType = originFileObj.ContentType;
    const originMetadata = originFileObj.Metadata;
    const originMetadataWithPrefix = addAmzMetaPrefix(originMetadata)

    //不是图片, 上传源文件返回
    if (operationsPrefix === 'original' || !isImage(originContentType)) {
        //上传
        try {
            await uploadFile(originFileObj.Body, cacheKey, originContentType, originMetadata);
        } catch (error) {
            return newError('Could not upload origin file to S3', error);
        } finally {
            startTime = printTiming('Upload origin file', startTime)
        }
        // 返回响应
        return {
            statusCode: 200,
            headers: mergeObjects(originMetadataWithPrefix, {'Content-Type': originContentType}),
            isBase64Encoded: true,
            body: originFileObj.Body.toString('base64')
        }
    }

    // 解析转换参数
    const operations = {};
    const operationsArray = operationsPrefix.split(',');
    operationsArray.forEach(operation => {
        const operationKV = operation.split("=");
        operations[operationKV[0]] = operationKV[1];
    });

    // 执行转换
    let transformedImageInfo;
    try {
        transformedImageInfo = await transImage(originFileObj, operations)
    } catch (error) {
        return newError('Transforming image failed', error);
    } finally {
        startTime = printTiming('Transform image', startTime)
    }

    // 上传转换后的图片
    try {
        await uploadFile(transformedImageInfo.Buff, cacheKey, transformedImageInfo.ContentType, mergeObjects(originMetadata, {'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL}));
    } catch (error) {
        return newError('Could not upload transformed image to S3', error);
    } finally {
        printTiming('Upload transformed image', startTime)
    }

    // 返回转换后的图
    return {
        statusCode: 200,
        headers: mergeObjects(originMetadataWithPrefix, {'Content-Type': transformedImageInfo.ContentType, 'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL}),
        isBase64Encoded: true,
        body: transformedImageInfo.Buff.toString('base64')
    }
};

// 从源桶下载文件
async function downloadFile(originalImagePath) {
    return await S3.getObject({Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath}).promise();
}

// 上传文件到缓存桶
async function uploadFile(body, filePath, contentType, metadata) {
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        await S3.putObject({
            Body: body,
            Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
            Key: filePath,
            ContentType: contentType,
            Metadata: metadata,
        }).promise();
    }
}

// 处理图片
async function transImage(imageFile, operations) {
    let transformedImage = Sharp(imageFile.Body, {failOn: 'none'});
    const metadata = await transformedImage.metadata();
    // 大小缩放
    const resizeOptions = {};
    if (operations['width']) {
        resizeOptions.width = parseInt(operations['width']);
    }
    if (operations['height']) {
        resizeOptions.height = parseInt(operations['height']);
    }
    if (resizeOptions) {
        transformedImage = transformedImage.resize(resizeOptions);
    }

    // 旋转
    if (metadata.orientation) {
        transformedImage = transformedImage.rotate();
    }

    // 不需要转格式, 直接返回
    const preferFormat = operations['format'];
    if (!preferFormat) {
        return {
            Buff: await transformedImage.toBuffer(),
            ContentType: imageFile.ContentType
        }
    }

    // 有损
    const imgFormat = getFormat(preferFormat);
    const quality = operations['quality'];
    if (imgFormat.SupportQuality && quality) {
        return {
            Buff: await transformedImage.toFormat(imgFormat.Format, {quality: parseInt(quality)}).toBuffer(),
            ContentType: imgFormat.ContentType
        }
    }

    // 无损
    return {
        Buff: await transformedImage.toFormat(imgFormat.Format).toBuffer(),
        ContentType: imgFormat.ContentType
    }
}

// 是否图片
function isImage(contentType) {
    return contentType && contentType.toString().toLowerCase().startsWith('image');
}

// 根据格式名获取格式描述
function getFormat(format) {
    for (let key in ImageFormat) {
        const value = ImageFormat[key];
        if (value.Name === format) {
            return value;
        }
    }
    return ImageFormat.JPEG;
}

function mergeObjects(...objs) {
    const mergedObject = {};
    objs.forEach(obj => {
        if (obj !== null) {
            Object.assign(mergedObject, obj);
        }
    });
    return mergedObject;
}

// 对 s3 元数据添加前缀
function addAmzMetaPrefix(obj) {
    const result = {}
    if (!obj) {
        return result;
    }
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) {  // 确保只处理对象自身的属性
            result['x-amz-meta-' + key] = obj[key];
        }
    }
    return result;
}

// 打印阶段耗时
function printTiming(step, start) {
    if (LOG_TIMING === 'true') {
        console.log(`${step} took ${parseInt(performance.now() - start).toString()}ms`);
        return performance.now();
    }
    return 0;
}

// 打印错误
function newError(message, error) {
    console.log('APPLICATION ERROR', message);
    console.log(error);
    return {
        statusCode: 500,
        body: message,
    }
}
