// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const {v4: uuidv4} = require('uuid');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

const S3 = new AWS.S3({signatureVersion: 'v4', httpOptions: {agent: new https.Agent({keepAlive: true})}});
const S3_ORIGINAL_FILE_BUCKET = process.env.originBucketName;
const S3_TRANSFORMED_FILE_BUCKET = process.env.cacheBucketName;
const TRANSFORMED_FILE_CACHE_TTL = process.env.cacheTTL;
const SECRET_KEY = process.env.secretKey;
const LOG_TIMING = process.env.logTiming;

const OptionKey = {
    FORMAT: 'format',
    QUALITY: 'quality',
    WIDTH: 'width',
    HEIGHT: 'height',
    BITRATE: 'bitrate'
};

const MediaType = {
    IMAGE: 'image',
    AUDIO: 'audio'
};

const ImageFormat = {
    JPG: {Name: 'jpg', Type: MediaType.IMAGE, Format: 'jpeg', ContentType: 'image/jpeg', SupportQuality: true},
    JPEG: {Name: 'jpeg', Type: MediaType.IMAGE, Format: 'jpeg', ContentType: 'image/jpeg', SupportQuality: true},
    PNG: {Name: 'png', Type: MediaType.IMAGE, Format: 'png', ContentType: 'image/png', SupportQuality: false},
    WEBP: {Name: 'webp', Type: MediaType.IMAGE, Format: 'webp', ContentType: 'image/webp', SupportQuality: true},
    GIF: {Name: 'gif', Type: MediaType.IMAGE, Format: 'gif', ContentType: 'image/gif', SupportQuality: false},
    TIF: {Name: 'tif', Type: MediaType.IMAGE, Format: 'tiff', ContentType: 'image/tiff', SupportQuality: true},
    TIFF: {Name: 'tiff', Type: MediaType.IMAGE, Format: 'tiff', ContentType: 'image/tiff', SupportQuality: true},
    AVIF: {Name: 'avif', Type: MediaType.IMAGE, Format: 'avif', ContentType: 'image/avif', SupportQuality: true},
    SVG: {Name: 'svg', Type: MediaType.IMAGE, Format: 'svg', ContentType: 'image/svg+xml', SupportQuality: false}
};

const AudioFormat = {
    MP3: {Name: 'mp3', Type: MediaType.AUDIO, Codec: 'libmp3lame', Format: 'mp3', ContentType: 'audio/mpeg', SupportBitrate: true},
    AAC: {Name: 'aac', Type: MediaType.AUDIO, Codec: 'aac', Format: 'aac', ContentType: 'audio/aac', SupportBitrate: true},
    AC3: {Name: 'ac3', Type: MediaType.AUDIO, Codec: 'ac3', Format: 'ac3', ContentType: 'audio/ac3', SupportBitrate: true},
    FLAC: {Name: 'flac', Type: MediaType.AUDIO, Codec: 'flac', Format: 'flac', ContentType: 'audio/flac', SupportBitrate: false},
    ALAC: {Name: 'alac', Type: MediaType.AUDIO, Codec: 'alac', Format: 'alac', ContentType: 'audio/alac', SupportBitrate: false},
    WAV: {Name: 'wav', Type: MediaType.AUDIO, Codec: 'pcm_s16le', Format: 'wav', ContentType: 'audio/wav', SupportBitrate: false},
    MID: {Name: 'mid', Type: MediaType.AUDIO, Codec: 'midi', Format: 'midi', ContentType: 'audio/midi', SupportBitrate: false},
    MIDI: {Name: 'midi', Type: MediaType.AUDIO, Codec: 'midi', Format: 'midi', ContentType: 'audio/midi', SupportBitrate: false}
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
    const cacheKey = `${originFilePath}/${optionsPrefix}`;
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
    const options = resolveOptions(optionsPrefix);//解析参数
    if (optionsPrefix === 'original' || !isSupported(originContentType, options)) {
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
            headers: mergeObjects(originMetadataWithPrefix, {'Content-Type': originContentType, 'Cache-Control': TRANSFORMED_FILE_CACHE_TTL}),
            isBase64Encoded: true,
            body: originFileObj.Body.toString('base64')
        };
    }

    // 执行转换
    let transformedResult;
    if (isImage(originContentType, options)) {
        // 转换图片
        try {
            transformedResult = await transImage(originFileObj, options);
        } catch (error) {
            return newError('Transforming image failed', error);
        } finally {
            startTime = printTiming('Transform image', startTime);
        }
    } else {
        // 转换音频
        try {
            transformedResult = await transAudio(originFileObj, options, originFilePath);
        } catch (error) {
            return newError('Transforming audio failed', error);
        } finally {
            startTime = printTiming('Transform audio', startTime);
        }
    }

    // 上传转换后的文件
    try {
        await uploadFile(transformedResult.Buff, cacheKey, transformedResult.ContentType, originMetadata);
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
            CacheControl: TRANSFORMED_FILE_CACHE_TTL,
            Metadata: metadata
        }).promise();
    }
}

// 处理图片
async function transImage(imageFile, options) {
    let outputImage = sharp(imageFile.Body, {failOn: 'none'});
    const metadata = await outputImage.metadata();
    // 大小缩放
    const resizeOptions = {};
    if (options[OptionKey.WIDTH]) {
        resizeOptions.width = parseInt(options[OptionKey.WIDTH]);
    }
    if (options[OptionKey.HEIGHT]) {
        resizeOptions.height = parseInt(options[OptionKey.HEIGHT]);
    }
    if (isNotEmpty(resizeOptions)) {
        outputImage = outputImage.resize(resizeOptions);
    }

    // 旋转
    if (metadata.orientation) {
        outputImage = outputImage.rotate();
    }

    // 不需要转格式, 直接返回
    const imageFormat = resolveImageFormat(options[OptionKey.FORMAT]);
    if (!imageFormat) {
        return {
            Buff: await outputImage.toBuffer(),
            ContentType: imageFile.ContentType
        };
    }

    // 有损
    const quality = options[OptionKey.QUALITY];
    if (imageFormat.SupportQuality && quality) {
        return {
            Buff: await outputImage.toFormat(imageFormat.Format, {quality: parseInt(quality)}).toBuffer(),
            ContentType: imageFormat.ContentType
        };
    }

    // 无损
    return {
        Buff: await outputImage.toFormat(imageFormat.Format).toBuffer(),
        ContentType: imageFormat.ContentType
    };
}

// 转音频
async function transAudio(audioFile, options, audioFileKey) {
    //解析格式
    const audioFormat = resolveAudioFormat(options[OptionKey.FORMAT]);
    //临时文件
    const tmpDir = '/tmp';
    const inputExt = path.extname(audioFileKey);//带点号, 例如 .mp3
    const inputFilePath = path.join(tmpDir, `${uuidv4()}${inputExt}`);
    const outputExt = audioFormat ? `.${audioFormat.Format}` : inputExt;
    const outputFilePath = path.join(tmpDir, `${uuidv4()}${outputExt}`);
    //等待异步转换完成
    await new Promise((resolve, reject) => {
        //将下载的文件写入临时路径
        fs.writeFileSync(inputFilePath, audioFile.Body);
        //创建转换命令
        const ffmpegCmd = ffmpeg(inputFilePath);
        //指定了目标格式
        if (audioFormat) {
            ffmpegCmd.audioCodec(audioFormat.Codec);
        }
        //计算目标码率
        const bitrate = computeBitrate(options[OptionKey.BITRATE], audioFormat, inputExt);
        if (bitrate) {
            ffmpegCmd.audioBitrate(bitrate);
        }
        //异步转换
        ffmpegCmd.save(outputFilePath)
            .on('start', (commandLine) => {
                console.log(`The audio conversion started: ${commandLine}`);
            })
            .on('end', () => {
                console.log('The audio conversion completed successfully');
                resolve();
            })
            .on('error', (error) => {
                reject(error);
            })
            .run();
    });
    // 返回
    return {
        Buff: fs.readFileSync(outputFilePath),
        ContentType: audioFormat ? audioFormat.ContentType : audioFile.ContentType
    };
}

// 是否支持
function isSupported(contentType, options) {
    if (!contentType) {
        return false;
    }
    return isImage(contentType, options) || isAudio(contentType, options);
}

// 是否图片
function isImage(contentType, options) {
    if (!contentType) {
        return false;
    }
    const contentTypeLower = contentType.toString().toLowerCase();
    return contentTypeLower.startsWith(MediaType.IMAGE) &&
        (options[OptionKey.FORMAT] || options[OptionKey.QUALITY] || options[OptionKey.WIDTH] || options[OptionKey.HEIGHT]);
}

// 是否音频
function isAudio(contentType, options) {
    if (!contentType) {
        return false;
    }
    const contentTypeLower = contentType.toString().toLowerCase();
    return contentTypeLower.startsWith(MediaType.AUDIO) &&
        (options[OptionKey.FORMAT] || options[OptionKey.BITRATE]);
}

// 将参数解析为 kv 的对象
function resolveOptions(optionString) {
    if (!optionString) {
        return {};
    }
    const options = {};
    const optionArray = optionString.split(',');
    for (let kv of optionArray) {
        const optionKV = kv.split('=');
        options[optionKV[0]] = optionKV[1];
    }
    return options;
}

// 解析图片目标格式
function resolveImageFormat(format) {
    if (!format) {
        return undefined;
    }
    for (let key in ImageFormat) {
        const value = ImageFormat[key];
        if (value.Name === format) {
            return value;
        }
    }
    return undefined;
}

// 解析音频目标格式
function resolveAudioFormat(format) {
    if (!format) {
        return undefined;
    }
    for (let key in AudioFormat) {
        const value = AudioFormat[key];
        if (value.Name === format) {
            return value;
        }
    }
    return undefined;
}

// 计算最终使用的码率, undefined 表示不要设置目标码率
function computeBitrate(bitrate, audioFormat, inputExt) {
    const defaultBitrate = '32k';
    //明确指定了目标格式
    if (audioFormat) {
        //目标格式支持码率, 返回参数的码率或默认码率
        if (audioFormat.SupportBitrate) {
            return bitrate ? bitrate : defaultBitrate;
        }
        return undefined;
    }
    //未指明目标格式, 则通过源的扩展名进行判断
    const ext = trimStart(inputExt, '.');
    const sourceFormat = resolveAudioFormat(ext);
    if (sourceFormat) {
        //源格式支持码率, 返回参数的码率或默认码率
        if (sourceFormat.SupportBitrate) {
            return bitrate ? bitrate : defaultBitrate;
        }
        return undefined;
    }
    return undefined;
}

// 合并对象
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

// 移除前缀
function trimStart(str, prefix) {
    if (!str || !prefix) {
        return str;
    }
    if (str.startsWith(prefix)) {
        return str.substring(prefix.length);
    }
    return str;
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
