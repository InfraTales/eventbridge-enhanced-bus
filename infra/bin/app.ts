#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { OrdersBusStack, parseContext } from '../lib/orders-bus-stack';

const app = new cdk.App();

new OrdersBusStack(app, 'OrdersBus', {
  ...parseContext(app),
  // The enhanced bus launched in 14 Regions, us-east-1 among them.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
