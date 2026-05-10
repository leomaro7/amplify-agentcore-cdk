import { Duration, Stack } from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from 'deploy-time-build';
import { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 指定されたCDKスタックに、AgentCoreランタイム関連のリソース一式を作成する関数
export function createAgentCoreRuntime(
  stack: Stack,
  userPool: IUserPool,
  userPoolClient: IUserPoolClient
) {
  // CodeBuildでARM64イメージをビルド（deploy-time-buildを利用）
  const agentImage = new ContainerImageBuild(stack, 'AgentImage', {
    directory: path.dirname(fileURLToPath(import.meta.url)),
    platform: Platform.LINUX_ARM64,
  });

  // Amplify コンテキストから appId と branchName を取得して安定した識別子を生成
  // スタック名ではなくコンテキスト値を使うことでビルドごとに名前が変わらない
  const appId = (stack.node.tryGetContext('amplify-backend-namespace') as string | undefined) ?? stack.account;
  const branchName = (stack.node.tryGetContext('amplify-backend-name') as string | undefined) ?? 'main';
  const envId = `${appId}_${branchName}`.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

  // STM用のMemoryリソースを作成（LTM戦略なし＝短期記憶のみ）
  const memory = new agentcore.Memory(stack, 'AgentMemory', {
    memoryName: `agent_memory_${envId}`,
    expirationDuration: Duration.days(7),
    description: 'Short-term memory for agent conversations',
  });

  // AgentCoreランタイムを作成（L2コンストラクト利用）
  const runtime = new agentcore.Runtime(stack, 'UpdateCheckerRuntime', {
    runtimeName: `update_checker_${envId}`,
    agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
      agentImage.repository,
      agentImage.imageTag
    ),
    // AgentCore Identityでインバウンド認証を設定
    authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
      userPool,
      [userPoolClient],
    ),
    networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
    environmentVariables: {
      MEMORY_ID: memory.memoryId,
    },
  });

  // ランタイムにSTMの読み書き権限を付与
  memory.grantWrite(runtime);
  memory.grantReadShortTermMemory(runtime);

  // Bedrock APIの利用権限を追加
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream'
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    })
  );

  return { runtime };
}
