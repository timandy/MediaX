// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface MediaxResourceProps {
  AppId: string;
  Url: string;
}

export class MediaxResource extends Construct {
  public readonly hostname: string;

  constructor(scope: Construct, id: string, props: MediaxResourceProps) {
    super(scope, id);

    const onEvent = new lambda.SingletonFunction(this, 'mediaxSingleton', {
      uuid: props.AppId,
      code: lambda.Code.fromAsset('functions/mediax-resource'),
      handler: 'index.on_event',
      timeout: cdk.Duration.seconds(300),
      runtime: lambda.Runtime.PYTHON_3_9,
      logRetention: logs.RetentionDays.ONE_DAY,
    });

    const mediaxProvider = new cr.Provider(this, 'mediaxProvider', {
      onEventHandler: onEvent,
      logRetention: logs.RetentionDays.ONE_DAY
    });

    const resource = new cdk.CustomResource(this, 'mediaxCustomResource', { serviceToken: mediaxProvider.serviceToken, properties: props });
    this.hostname = resource.getAtt('HostName').toString();
  }
}
