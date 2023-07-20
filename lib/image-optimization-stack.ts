// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Aws, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MyCustomResource } from './my-custom-resource';
import { createHash } from 'crypto';

// Region to Origin Shield mapping based on latency. to be updated when new Regional Edge Caches are added to CloudFront.
const ORIGIN_SHIELD_MAPPING = new Map([['af-south-1', 'eu-west-2'], ['ap-east-1', 'ap-northeast-2'], ['ap-northeast-1', 'ap-northeast-1'], [
  'ap-northeast-2', 'ap-northeast-2'], ['ap-northeast-3', 'ap-northeast-1'], ['ap-south-1', 'ap-south-1'], ['ap-southeast-1', 'ap-southeast-1'], [
  'ap-southeast-2', 'ap-southeast-2'], ['ca-central-1', 'us-east-1'], ['eu-central-1', 'eu-central-1'], ['eu-north-1', 'eu-central-1'], [
  'eu-south-1', 'eu-central-1'], ['eu-west-1', 'eu-west-1'], ['eu-west-2', 'eu-west-2'], ['eu-west-3', 'eu-west-2'], ['me-south-1', 'ap-south-1'], [
  'sa-east-1', 'sa-east-1'], ['us-east-1', 'us-east-1'], ['us-east-2', 'us-east-2'], ['us-west-1', 'us-west-1'], ['us-west-2', 'us-west-2']]);

// Stack Parameters

// related to architecture. If set to false, transformed images are not stored in S3, and all image requests land on Lambda
let STORE_TRANSFORMED_IMAGES = 'true';
// Parameters of S3 bucket where original images are stored
let S3_IMAGE_BUCKET_NAME: string;
// CloudFront parameters
let CLOUDFRONT_ORIGIN_SHIELD_REGION = ORIGIN_SHIELD_MAPPING.get(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');
let CLOUDFRONT_CORS_ENABLED = 'true';
let CLOUDFRONT_DOMAIN_NAMES: string[];
// Parameters of transformed images
let S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
let S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
// Lambda Parameters
let LAMBDA_MEMORY = '1500';
let LAMBDA_TIMEOUT = '60';
let LOG_TIMING = 'true';

type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  originBucketName: string,
  cacheBucketName?: any;
  cacheTTL: string,
  secretKey: string,
  logTiming: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 获取参数
    STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
    S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
    S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
    CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    LOG_TIMING = this.node.tryGetContext('LOG_TIMING') || LOG_TIMING;

    // 未指定源桶, 直接抛出异常
    if (!S3_IMAGE_BUCKET_NAME) {
      throw new Error('S3_IMAGE_BUCKET_NAME can not be empty')
    }

    // 创建一个自定义密码, 访问 lambda 时使用
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex');

    // 声明源桶和缓存桶
    let originImageBucket;
    let cacheImageBucket;
    const iamPolicyStatements: iam.PolicyStatement[] = [];//权限语句组

    // 源桶
    originImageBucket = s3.Bucket.fromBucketName(this, 'originImageS3Bucket', S3_IMAGE_BUCKET_NAME);
    new CfnOutput(this, 'originImageS3BucketCfn', {
      description: 'S3 bucket where origin images are stored',
      value: originImageBucket.bucketName
    });
    iamPolicyStatements.push(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::' + originImageBucket.bucketName + '/*'],
    }));

    // 如果开启了存储缩略图, 为转换后的映像创建存储桶, 默认开启
    if (STORE_TRANSFORMED_IMAGES === 'true') {
      cacheImageBucket = new s3.Bucket(this, 'cacheImageS3Bucket', {
        bucketName: `${originImageBucket.bucketName}.thumb`,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)), //缩略图存储天数, 默认 90 天
          },
        ],
      });
      new CfnOutput(this, 'cacheImageS3BucketCfn', {
        description: 'S3 bucket where transformed images are stored',
        value: cacheImageBucket.bucketName
      });
      iamPolicyStatements.push(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['arn:aws:s3:::' + cacheImageBucket.bucketName + '/*'],
      }));
    }

    // 准备 Lambda 环境变量
    const lambdaEnv: LambdaEnv = {
      originBucketName: originImageBucket.bucketName,
      cacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      secretKey: SECRET_KEY,
      logTiming: LOG_TIMING,
    };
    if (cacheImageBucket)
      lambdaEnv.cacheBucketName = cacheImageBucket.bucketName;

    // 创建用于图像处理的 Lambda
    const imageProcessing = new lambda.Function(this, 'imageOptimization', {
      functionName: `ImageOptimization_${id}`,
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
      layers: [lambda.LayerVersion.fromLayerVersionArn(this, 'ffmpegLayer', `arn:aws:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:layer:ffmpeg-node-layer:1`)]
    });
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'imageIamPolicy', {
        policyName: `ImageIamPolicy_${id}`,
        statements: iamPolicyStatements,
      }),
    );

    // 启用 Lambda URL 地址访问
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // 利用自定义资源获取 Lambda URL 的主机名
    const imageProcessingHelper = new MyCustomResource(this, 'customResource', {
      AppId: id,
      Url: imageProcessingURL.url
    });

    // 创建 CloudFront 源
    let deliveryOrigin;
    if (cacheImageBucket) {//保存缩略图: 首先尝试回源到缩略图桶, 如果失败则执行 Lambda
      deliveryOrigin = new origins.OriginGroup({
        primaryOrigin: new origins.S3Origin(cacheImageBucket, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingHelper.hostname, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
          customHeaders: {
            'x-origin-secret-header': SECRET_KEY,
          },
        }),
        fallbackStatusCodes: [403],
      });
    } else {//不保存缩略图: 直接执行 Lambda
      deliveryOrigin = new origins.HttpOrigin(imageProcessingHelper.hostname, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      });
    }


    // 创建用于 url 重写的 CloudFront 函数
    const urlRewriteFunction = new cloudfront.Function(this, 'imageUrlRewriteFunction', {
      functionName: `ImageUrlRewriteFunction_${id}`,
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
    });

    // 创建 CloudFront 缓存策略
    const cachePolicy = new cloudfront.CachePolicy(this, 'imageCachePolicy', {
      cachePolicyName: `ImageCachePolicy_${id}`,
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
    });

    // 创建 CloudFront 行为
    const imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: deliveryOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cachePolicy,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      //设置响应头策略
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'imageResponseHeadersPolicy', {
        responseHeadersPolicyName: `ImageResponseHeadersPolicy_${id}`,
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
        //打标记
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-image-optimization', value: 'v1.0', override: true }
          ],
        }
      });

      // 创建 CloudFront 分配
      const cfDistribution = new cloudfront.Distribution(this, 'imageDistribution', {
        comment: `image optimization - ${originImageBucket.bucketName}`,
        domainNames: CLOUDFRONT_DOMAIN_NAMES,
        defaultBehavior: imageDeliveryCacheBehaviorConfig
      });
      new CfnOutput(this, 'imageDeliveryDistributionCfn', {
        description: 'Domain name of image delivery',
        value: cfDistribution.distributionDomainName
      });
    }
  }
}
