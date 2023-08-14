#!/bin/bash

# 删除上次文件
rm -f layer.zip

# 下载 安装包
if [[ ! -f 'download/ffmpeg-release-amd64-static.tar.xz' ]]; then
  curl -o '/tmp/ffmpeg-release-amd64-static.tar.xz' 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
  mv -f /tmp/ffmpeg-release-amd64-static.tar.xz download/ffmpeg-release-amd64-static.tar.xz
fi

# 下载 安装包
if [[ ! -f 'download/ffmpeg-release-amd64-static.tar.xz.md5' ]]; then
  curl -o '/tmp/ffmpeg-release-amd64-static.tar.xz.md5' 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz.md5'
  mv -f /tmp/ffmpeg-release-amd64-static.tar.xz.md5 download/ffmpeg-release-amd64-static.tar.xz.md5
fi

# 校验 md5
md5sum -c download/ffmpeg-release-amd64-static.tar.xz.md5

# 解压
mkdir -p temp
tar -xvf download/ffmpeg-release-amd64-static.tar.xz -C temp

# 查找解压出来的目录
folder=$(find temp/ -type d -name 'ffmpeg-*-amd64-static')
if [ -z "$folder" ]; then
   echo 'The extracted directory could not be found'
   exit 1
fi

# 重命名
mv -f "$folder" temp/bin

# 压缩为 lambda layer 格式的zip包
cd temp && zip -r ../layer.zip . && cd ..

# 清理
rm -rf temp

# 创建临时 bucket
bucketName="temp-ffmpeg-layer-$(uuidgen)"
aws s3api create-bucket --bucket "$bucketName" --create-bucket-configuration "LocationConstraint=$(aws configure get region)"

# 上传到 s3
aws s3 cp layer.zip "s3://$bucketName/layer.zip"

# 创建层
aws lambda publish-layer-version \
    --layer-name 'ffmpeg-node-layer' \
    --description 'ffmpeg node layer' \
    --content "S3Bucket=$bucketName,S3Key=layer.zip" \
    --compatible-architectures 'x86_64' \
    --compatible-runtimes 'nodejs12.x' 'nodejs14.x' 'nodejs16.x' 'nodejs18.x' \
    --license-info 'https://www.ffmpeg.org/legal.html'

# 删除临时 bucket
aws s3 rm "s3://$bucketName" --recursive
aws s3api delete-bucket --bucket "$bucketName"

# 完成
echo 'ffmpeg-node-layer 部署完成'
