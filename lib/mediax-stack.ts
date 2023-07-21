// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Aws, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MediaxResource } from './mediax-resource';
import { createHash } from 'crypto';

// Region to Origin Shield mapping based on latency. to be updated when new Regional Edge Caches are added to CloudFront.
const ORIGIN_SHIELD_MAPPING = new Map([['af-south-1', 'eu-west-2'], ['ap-east-1', 'ap-northeast-2'], ['ap-northeast-1', 'ap-northeast-1'], [
  'ap-northeast-2', 'ap-northeast-2'], ['ap-northeast-3', 'ap-northeast-1'], ['ap-south-1', 'ap-south-1'], ['ap-southeast-1', 'ap-southeast-1'], [
  'ap-southeast-2', 'ap-southeast-2'], ['ca-central-1', 'us-east-1'], ['eu-central-1', 'eu-central-1'], ['eu-north-1', 'eu-central-1'], [
  'eu-south-1', 'eu-central-1'], ['eu-west-1', 'eu-west-1'], ['eu-west-2', 'eu-west-2'], ['eu-west-3', 'eu-west-2'], ['me-south-1', 'ap-south-1'], [
  'sa-east-1', 'sa-east-1'], ['us-east-1', 'us-east-1'], ['us-east-2', 'us-east-2'], ['us-west-1', 'us-west-1'], ['us-west-2', 'us-west-2']]);

// 源桶参数
let S3_ORIGIN_BUCKET_NAME: string;
// 缓存桶参数
let S3_CACHE_BUCKET_EXPIRATION_DAYS = '90';
let S3_CACHE_BUCKET_CACHE_TTL = 'max-age=31622400';
// CloudFront 参数
let CLOUDFRONT_ORIGIN_SHIELD_REGION = ORIGIN_SHIELD_MAPPING.get(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');
let CLOUDFRONT_CORS_ENABLED = 'true';
let CLOUDFRONT_DOMAIN_NAME: string;
// Lambda 参数
let LAMBDA_MEMORY = '1500';
let LAMBDA_TIMEOUT = '60';
// 是否打印耗时信息
let LOG_TIMING = 'true';

type CloudFrontBehavior = {
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

export class MediaxStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 获取 S3 参数
    S3_ORIGIN_BUCKET_NAME = this.node.tryGetContext('S3_ORIGIN_BUCKET_NAME') || S3_ORIGIN_BUCKET_NAME;
    S3_CACHE_BUCKET_EXPIRATION_DAYS = this.node.tryGetContext('S3_CACHE_BUCKET_EXPIRATION_DAYS') || S3_CACHE_BUCKET_EXPIRATION_DAYS;
    S3_CACHE_BUCKET_CACHE_TTL = this.node.tryGetContext('S3_CACHE_BUCKET_CACHE_TTL') || S3_CACHE_BUCKET_CACHE_TTL;
    // 获取 CloudFront 参数
    CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    CLOUDFRONT_DOMAIN_NAME = this.node.tryGetContext('CLOUDFRONT_DOMAIN_NAME') || CLOUDFRONT_DOMAIN_NAME;
    // 获取 Lambda 参数
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    // 获取日志参数
    LOG_TIMING = this.node.tryGetContext('LOG_TIMING') || LOG_TIMING;

    // 未指定源桶, 直接抛出异常
    if (!S3_ORIGIN_BUCKET_NAME) {
      throw new Error('S3_ORIGIN_BUCKET_NAME can not be empty')
    }

    // 创建一个自定义密码, 访问 lambda 时使用
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex');

    // 源桶
    const originBucket = s3.Bucket.fromBucketName(this, 'mediaxOriginBucket', S3_ORIGIN_BUCKET_NAME);
    new CfnOutput(this, 'mediaxOriginBucketCfn', {
      description: 'S3 bucket where origin files are stored',
      value: originBucket.bucketName
    });

    // 为转换后的文件创建存储桶
    const cacheBucket = new s3.Bucket(this, 'mediaxCacheBucket', {
      bucketName: `${originBucket.bucketName}.thumb`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: Duration.days(parseInt(S3_CACHE_BUCKET_EXPIRATION_DAYS)), //缩略图存储天数, 默认 90 天
        },
      ],
    });
    new CfnOutput(this, 'mediaxCacheBucketCfn', {
      description: 'S3 bucket where transformed files are stored',
      value: cacheBucket.bucketName
    });

    // 准备 Lambda 权限策略
    const lambdaPolicy = new iam.Policy(this, 'mediaxIamPolicy', {
      policyName: `MediaxIamPolicy_${id}`,
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: ['arn:aws:s3:::' + originBucket.bucketName + '/*'],
        }),
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: ['arn:aws:s3:::' + cacheBucket.bucketName + '/*'],
        })
      ]
    });

    // 准备 Lambda 环境变量
    const lambdaEnv: LambdaEnv = {
      originBucketName: originBucket.bucketName,
      cacheBucketName: cacheBucket.bucketName,
      cacheTTL: S3_CACHE_BUCKET_CACHE_TTL,
      secretKey: SECRET_KEY,
      logTiming: LOG_TIMING,
    };

    // 创建用于图像处理的 Lambda
    const mediaxLambda = new lambda.Function(this, 'mediaxLambda', {
      functionName: `MediaxProcess_${id}`,
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/mediax-process'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
      layers: [lambda.LayerVersion.fromLayerVersionArn(this, 'mediaxFFmpegLayer', `arn:aws:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:layer:ffmpeg-node-layer:1`)]
    });
    mediaxLambda.role?.attachInlinePolicy(lambdaPolicy);

    // 启用 Lambda URL 地址访问
    const mediaxLambdaURL = mediaxLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // 利用自定义资源获取 Lambda URL 的主机名
    const mediaxLambdaResource = new MediaxResource(this, 'mediaxResource', {
      AppId: id,
      Url: mediaxLambdaURL.url
    });

    // 创建 CloudFront 源组, 首先尝试回源到缩略图桶, 如果失败则执行 Lambda
    const deliveryOrigin = new origins.OriginGroup({
      primaryOrigin: new origins.S3Origin(cacheBucket, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
      }),
      fallbackOrigin: new origins.HttpOrigin(mediaxLambdaResource.hostname, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      }),
      fallbackStatusCodes: [403],
    });

    // 创建 CloudFront 函数, 用于 url 重写
    const urlRewriteFunc = new cloudfront.Function(this, 'mediaxUrlRewrite', {
      functionName: `MediaxUrlRewrite_${id}`,
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/mediax-urlrewrite/index.js' }),
    });

    // 创建 CloudFront 缓存策略
    const cfCachePolicy = new cloudfront.CachePolicy(this, 'mediaxCachePolicy', {
      cachePolicyName: `MediaxCachePolicy_${id}`,
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
    });

    // 创建 CloudFront 缓存行为
    const cfBehavior: CloudFrontBehavior = {
      origin: deliveryOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cfCachePolicy,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunc,
      }],
    }

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      //设置响应头策略
      cfBehavior.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'mediaxResponseHeadersPolicy', {
        responseHeadersPolicyName: `MediaxResponseHeadersPolicy_${id}`,
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.hours(24),
          originOverride: false,
        },
        //打标记
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-mediax', value: 'v1.0', override: true }
          ],
        }
      });

      // 创建 CloudFront 分配
      const cfDistribution = new cloudfront.Distribution(this, 'mediaxDistribution', {
        comment: `MediaX - ${originBucket.bucketName}`,
        domainNames: [CLOUDFRONT_DOMAIN_NAME],
        defaultBehavior: cfBehavior
      });
      new CfnOutput(this, 'mediaxDistributionCfn', {
        description: 'Domain name of mediax delivery',
        value: cfDistribution.distributionDomainName
      });
    }
  }
}
