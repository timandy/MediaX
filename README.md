# MediaX

`MediaX` 是一套基于 `AWS` 云原生技术栈的 `Serverless` 媒体转换服务。

图像和音频通常是网页中最重的组成部分，优化网站上的媒体文件对于改善用户体验、降低交付成本和提高您在搜索引擎排名中的地位至关重要。

在该解决方案中，我们为您提供了一个简单且高性能的解决方案，用于使用 Amazon CloudFront、Amazon S3 和 AWS Lambda 等无服务器组件进行图像优化。

该的架构适用于比较常见的场景，仅当映像尚未转换和存储时，映像转换才会在 AWS 区域中集中执行。

可用的转换包括转换图像格式、调整图像大小、转换音频格式、调整音频码率。

这些转换都可以由前端请求，在服务器端完成格式转换并自动存储复用。

该架构基于 S3 进行存储，CloudFront 用于内容交付，Lambda 用于媒体处理。

下图介绍了请求流程：

<img src="architecture.png" width="900">

1. 用户发送具有特定转换（如编码和大小）的媒体的 HTTP 请求。
   转换在 URL 中编码，更准确地说是作为查询参数。

2. 请求由附近的 CloudFront 边缘站点处理，以提供最佳性能。
   在将请求传递到上游之前，会在查看器请求事件上执行 CloudFront 函数以重写请求 URL。
   CloudFront Functions 是 CloudFront 的一项功能，允许您在 JavaScript 中编写轻量级函数，以实现大规模、延迟敏感的 CDN 自定义。
   在我们的架构中，我们重写 URL 以验证请求的转换，并通过对转换进行排序来规范化 URL，并将其转换为小写以提高缓存命中率。
   当请求自动转换时，该函数还会决定要应用的最佳转换。
   例如，如果用户使用指令 format=auto 请求最优化的媒体格式（JPEG、WebP 或 AVIF），CloudFront 函数将根据请求中存在的 Accept 标头选择最佳格式。

3. 如果请求的文件已缓存在 CloudFront 中，则缓存命中，并且文件将从 CloudFront 缓存返回。
   为了提高缓存命中率，我们启用了源盾（CloudFront 的一项功能，可在源之前充当额外的缓存层），以进一步从请求中卸载它。
   如果文件不在 CloudFront 缓存中，则请求将转发到 S3 存储桶，该存储桶用于存储转换后的文件。
   如果请求的文件已转换并存储在 S3 中，则只需在 CloudFront 中提供和缓存该文件即可。

4. 否则，S3 将响应 403 错误代码，CloudFront 的源故障转移会检测到该代码。
   借助此本机功能，CloudFront 重试相同的 URL，但这次使用的是基于 Lambda 函数 URL 的辅助源。
   调用时，Lambda 函数从存储原始文件的另一个 S3 存储桶下载原始文件，使用 Sharp 或 FFmpeg 库对其进行转换。
   将转换后的媒体文件存储在 S3 中，然后通过 CloudFront 提供该文件，并在 CloudFront 中缓存该文件以供将来的请求使用。

请注意以下几点：

* 转换后的文件存储在 S3 中，生命周期策略会在一定持续时间（默认为 90 天）后将其删除，以降低存储成本。
  理想情况下，应根据对新文件的请求数显著下降的持续时间设置此值。
  除了基于规范化媒体文件转换的后缀外，它们还使用与原始文件相同的键创建。
  例如，如果自动检测到的格式是 webp，则响应 `/mycat.jpg?format=auto&width=200` 的转换媒体文件将使用键 `/mycat.jpg/format=webp,width=200` 存储。
  要删除 S3 中同一媒体文件的所有生成变体，请删除原始文件 `/mycat.jpg/*` 键下列出的所有文件。

* 转换后的文件将添加到 S3，缓存控制标头为 1 年。
  如果您需要使 CloudFront 中文件的所有缓存变体失效，请使用以下失效模式：`/mycat.jpg*`。

* 为了防止未经授权调用 Lambda 函数，CloudFront 配置为在自定义源标头中发送私有密钥，该密钥在处理文件之前在 Lambda 函数中进行验证。

## 使用 CDK 部署解决方案

AWS CDK 是一个开源软件开发框架，用于在代码中定义云基础设施，并通过 AWS CloudFormation 进行预置。
在命令行中按照以下步骤操作，使用 AWS CLI 中配置的区域和账户信息，使用 CDK 部署映像优化解决方案。

注意:

* 部署前需要先安装包含 FFmpeg 库的 Lambda Layer，以支持音频转换。[安装脚本](./ffmpeg/install.sh)
* 每部署一个 CloudFormation Stack 实例，只会针对一个 S3 桶启用媒体转换服务。
* 如果要支持多个不同的桶，需要修改 Stack 名和源 S3 桶名，并确保不重名。

```
git clone https://github.com/timandy/MediaX.git 
cd MediaX
npm install
cdk bootstrap
npm run build
cdk deploy
```

部署在几分钟内完成时，CDK 将输出以下信息。

* 分配域名
* 源桶名称
* 转换后媒体桶名称，通常是`源桶名称.thumb`

## 清理资源

若要删除为此解决方案创建的云资源，只需执行以下命令：

```
cdk destroy
```

## 使用

[客户端使用手册](./doc/Wiki.md)

## 参考

该库基于 [image-optimization](https://github.com/aws-samples/image-optimization) 开发并增加了诸多新特性。

改进特性：

* 支持多 Stack 部署，每个 Stack 对应一个 S3 桶。
* 支持音频转换。

## 费用

该库不收任何费用，但部署后使用的资源会产生费用。

[Cost considerations](https://aws.amazon.com/cn/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda)。

## License

该库根据 MIT-0 许可证获得许可。请参阅许可证文件。
