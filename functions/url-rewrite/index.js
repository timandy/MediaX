// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

var SUPPORTED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif', 'svg'];

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;
    // 验证、处理和规范化查询参数中的请求操作
    var options = resolveOptions(request);
    // 如果找到有效操作，则重写规范化版本的路径
    if (options) {
        // 按顺序重新组合
        var optionArray = [];
        if (options.format) optionArray.push('format=' + options.format);
        if (options.quality) optionArray.push('quality=' + options.quality);
        if (options.width) optionArray.push('width=' + options.width);
        if (options.height) optionArray.push('height=' + options.height);
        request.uri = originalImagePath + '/' + optionArray.join(',');
    } else {
        // 如果未找到有效参数，则使用 /original 路径后缀标记请求
        request.uri = originalImagePath + '/original';
    }

    // 移除 ? 后的参数
    request.querystring = {};
    return request;
}

// 解析参数
function resolveOptions(request) {
    var querystring = request.querystring;
    if (!querystring) {
        return {};
    }

    var options = {};
    var queryKeys = Object.keys(querystring);
    for (var i = 0; i < queryKeys.length; i++) {
        // 无效 optionKey
        var optionKey = queryKeys[i];
        if (!optionKey) {
            continue;
        }
        // 无效 optionValue
        var optionValue = querystring[optionKey].value;
        if (!optionValue) {
            continue;
        }
        optionKey = optionKey.toLowerCase();
        optionValue = optionValue.toLowerCase();
        switch (optionKey) {
            case 'format':
                if (optionValue === 'auto') {
                    var format = getFormatByAccept(request.headers.accept);
                    if (format) {
                        options['format'] = format;
                    }
                    break;
                }
                if (SUPPORTED_FORMATS.includes(optionValue)) {
                    options['format'] = optionValue;
                }
                break;

            case 'width':
                var width = getOptionValue(optionValue, 4000);
                if (width) {
                    options['width'] = width;
                }
                break;

            case 'height':
                var height = getOptionValue(optionValue, 4000);
                if (height) {
                    options['height'] = height;
                }
                break;

            case 'quality':
                var quality = getOptionValue(optionValue, 100);
                if (quality) {
                    options['quality'] = quality;
                }
                break;

            default:
                break;
        }
    }
    return options;
}

// 根据 accept 请求头自动判断格式
function getFormatByAccept(acceptHeader) {
    // header 不存在
    if (!acceptHeader) {
        return undefined;
    }
    // header 值不存在
    var accept = acceptHeader.value;
    if (!accept) {
        return undefined;
    }
    // header 值小写
    accept = accept.toLowerCase();
    // 查找格式
    for (var i = 0; i < SUPPORTED_FORMATS.length; i++) {
        var format = SUPPORTED_FORMATS[i];
        if (accept.includes(format)) {
            return format;
        }
    }
    return undefined;
}

// 将值转换为数字, 验证大小后, 返回字符串格式
function getOptionValue(optionValue, maxValue) {
    var value = parseInt(optionValue);
    if (!isNaN(value) && (value > 0)) {
        // you can protect the Lambda function by setting a max value;
        if (value > maxValue) value = maxValue;
        return value.toString();
    }
    return undefined;
}
