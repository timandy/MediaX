#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MediaxStack } from '../lib/mediax-stack';

const app = new cdk.App();
new MediaxStack(app, 'MediaX-Stack-mock-public', { description: 'Serverless media conversion service based on the AWS cloud-native technology stack' });
