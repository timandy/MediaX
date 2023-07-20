// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const {v4: uuidv4} = require('uuid');
const Sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

const S3 = new AWS.S3({signatureVersion: 'v4', httpOptions: {agent: new https.Agent({keepAlive: true})}});
const S3_ORIGINAL_FILE_BUCKET = process.env.originBucketName;
const S3_TRANSFORMED_FILE_BUCKET = process.env.cacheBucketName;
const TRANSFORMED_FILE_CACHE_TTL = process.env.cacheTTL;
const SECRET_KEY = process.env.secretKey;
const LOG_TIMING = process.env.logTiming;

const MediaType = {
    IMAGE: 'image',
    AUDIO: 'audio'
};

const MediaFormat = {
    //图片
    JPG: {Name: 'jpg', Type: MediaType.IMAGE, Format: 'jpeg', ContentType: 'image/jpeg', SupportQuality: true},
    JPEG: {Name: 'jpeg', Type: MediaType.IMAGE, Format: 'jpeg', ContentType: 'image/jpeg', SupportQuality: true},
    PNG: {Name: 'png', Type: MediaType.IMAGE, Format: 'png', ContentType: 'image/png', SupportQuality: false},
    WEBP: {Name: 'webp', Type: MediaType.IMAGE, Format: 'webp', ContentType: 'image/webp', SupportQuality: true},
    GIF: {Name: 'gif', Type: MediaType.IMAGE, Format: 'gif', ContentType: 'image/gif', SupportQuality: false},
    TIF: {Name: 'tif', Type: MediaType.IMAGE, Format: 'tiff', ContentType: 'image/tiff', SupportQuality: true},
    TIFF: {Name: 'tiff', Type: MediaType.IMAGE, Format: 'tiff', ContentType: 'image/tiff', SupportQuality: true},
    AVIF: {Name: 'avif', Type: MediaType.IMAGE, Format: 'avif', ContentType: 'image/avif', SupportQuality: true},
    SVG: {Name: 'svg', Type: MediaType.IMAGE, Format: 'svg', ContentType: 'image/svg+xml', SupportQuality: false},
    //音频
    AAC: {Name: 'aac', Type: MediaType.AUDIO, Format: 'aac', ContentType: 'audio/aac', SupportQuality: false}
};

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
    console.log(`==> GET ${requestPath}`);
    const requestPathArray = requestPath.split('/');
    // 最后一个元素出栈 format=auto,width=100 或 original
    const optionsPrefix = requestPathArray.pop();
    // 获取原始路径 images/rio/1.jpg
    requestPathArray.shift();
    const originFilePath = requestPathArray.join('/');
    // 缓存 key
    const cacheKey = originFilePath + '/' + optionsPrefix;
    // 起始时间
    let startTime = performance.now();
    // 下载源文件
    let originFileObj;
    try {
        originFileObj = await downloadFile(originFilePath);
    } catch (error) {
        return newError('Could not download origin file from S3', error);
    } finally {
        startTime = printTiming('Download origin file', startTime);
    }
    const originContentType = originFileObj.ContentType;
    const originMetadata = originFileObj.Metadata;
    const originMetadataWithPrefix = addAmzMetaPrefix(originMetadata);

    //不是图片, 上传源文件返回
    if (optionsPrefix === 'original' || !isSupported(originContentType)) {
        //上传
        try {
            await uploadFile(originFileObj.Body, cacheKey, originContentType, originMetadata);
        } catch (error) {
            return newError('Could not upload origin file to S3', error);
        } finally {
            startTime = printTiming('Upload origin file', startTime);
        }
        // 返回响应
        return {
            statusCode: 200,
            headers: mergeObjects(originMetadataWithPrefix, {'Content-Type': originContentType}),
            isBase64Encoded: true,
            body: originFileObj.Body.toString('base64')
        };
    }

    // 解析转换参数
    const options = {};
    const optionArray = optionsPrefix.split(',');
    optionArray.forEach(operation => {
        const operationKV = operation.split('=');
        options[operationKV[0]] = operationKV[1];
    });

    // 执行转换
    let transformedResult;
    const mediaFormat = resolveFormat(options);
    if (!mediaFormat || mediaFormat.Type === MediaType.IMAGE) {
        // 转换图片
        try {
            transformedResult = await transImage(originFileObj, options, mediaFormat);
        } catch (error) {
            return newError('Transforming image failed', error);
        } finally {
            startTime = printTiming('Transform image', startTime);
        }
    } else {
        // 转换音频
        try {
            transformedResult = await transAudio(originFilePath, originFileObj, options, mediaFormat);
        } catch (error) {
            return newError('Transforming audio failed', error);
        } finally {
            startTime = printTiming('Transform audio', startTime);
        }
    }

    // 上传转换后的文件
    try {
        await uploadFile(transformedResult.Buff, cacheKey, transformedResult.ContentType, mergeObjects(originMetadata, {'Cache-Control': TRANSFORMED_FILE_CACHE_TTL}));
    } catch (error) {
        return newError('Could not upload transformed file to S3', error);
    } finally {
        printTiming('Upload transformed file', startTime);
    }

    // 返回转换后的文件
    return {
        statusCode: 200,
        headers: mergeObjects(originMetadataWithPrefix, {'Content-Type': transformedResult.ContentType, 'Cache-Control': TRANSFORMED_FILE_CACHE_TTL}),
        isBase64Encoded: true,
        body: transformedResult.Buff.toString('base64')
    };
};

// 从源桶下载文件
async function downloadFile(originalImagePath) {
    return await S3.getObject({Bucket: S3_ORIGINAL_FILE_BUCKET, Key: originalImagePath}).promise();
}

// 上传文件到缓存桶
async function uploadFile(body, filePath, contentType, metadata) {
    if (S3_TRANSFORMED_FILE_BUCKET) {
        await S3.putObject({
            Body: body,
            Bucket: S3_TRANSFORMED_FILE_BUCKET,
            Key: filePath,
            ContentType: contentType,
            Metadata: metadata
        }).promise();
    }
}

// 处理图片
async function transImage(imageFile, operations, mediaFormat) {
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
    if (isNotEmpty(resizeOptions)) {
        transformedImage = transformedImage.resize(resizeOptions);
    }

    // 旋转
    if (metadata.orientation) {
        transformedImage = transformedImage.rotate();
    }

    // 不需要转格式, 直接返回
    if (!mediaFormat) {
        return {
            Buff: await transformedImage.toBuffer(),
            ContentType: imageFile.ContentType
        };
    }

    // 有损
    const quality = operations['quality'];
    if (mediaFormat.SupportQuality && quality) {
        return {
            Buff: await transformedImage.toFormat(mediaFormat.Format, {quality: parseInt(quality)}).toBuffer(),
            ContentType: mediaFormat.ContentType
        };
    }

    // 无损
    return {
        Buff: await transformedImage.toFormat(mediaFormat.Format).toBuffer(),
        ContentType: mediaFormat.ContentType
    };
}

// 转音频
async function transAudio(audioFileKey, audioFile, operations, mediaFormat) {
    //临时文件
    const tmpDir = '/tmp';
    const inputFilePath = path.join(tmpDir, `${uuidv4()}${(path.extname(audioFileKey))}`);
    const outputFilePath = path.join(tmpDir, `${uuidv4()}.${mediaFormat.Format}`);
    //将下载的文件写入临时路径
    fs.writeFileSync(inputFilePath, audioFile.Body);
    //执行转换
    await new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
            .audioCodec(mediaFormat.Format)
            .audioBitrate('32k')
            .save(outputFilePath)
            .on('end', () => {
                console.log('The conversion to aac completed successfully');
                resolve();
            })
            .on('error', (error) => {
                console.log('An error occurred while converting to aac', error);
                reject(error);
            })
            .run();
    });
    // 返回
    return {
        Buff: fs.readFileSync(outputFilePath),
        ContentType: mediaFormat.ContentType
    };
}

// 是否支持
function isSupported(contentType) {
    if (!contentType) {
        return false;
    }
    const contentTypeLower = contentType.toString().toLowerCase();
    return contentTypeLower.startsWith(MediaType.IMAGE) || contentTypeLower.startsWith(MediaType.AUDIO);
}

// 根据格式名获取格式描述
function resolveFormat(operations) {
    const format = operations['format'];
    if (!format) {
        return undefined;
    }
    for (let key in MediaFormat) {
        const value = MediaFormat[key];
        if (value.Name === format) {
            return value;
        }
    }
    return undefined;
}

function mergeObjects(...objs) {
    if (!objs) {
        return {};
    }
    const result = {};
    for (let obj of objs) {
        if (!obj) {
            continue;
        }
        Object.assign(result, obj);
    }
    return result;
}

// 对 s3 元数据添加前缀
function addAmzMetaPrefix(obj) {
    if (!obj) {
        return {};
    }
    const result = {};
    for (let key of Object.keys(obj)) {
        result[`x-amz-meta-${key}`] = obj[key];
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
        body: message
    };
}

// 是否空
function isEmpty(obj) {
    return !obj || (Array.isArray(obj) && obj.length === 0) || (typeof obj === 'object' && Object.keys(obj).length === 0);
}

// 是否非空
function isNotEmpty(obj) {
    return !isEmpty(obj);
}
