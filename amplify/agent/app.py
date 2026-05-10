import base64
import json
import os

from strands import Agent
from strands_tools.rss import rss
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
from bedrock_agentcore.memory import MemoryClient

app = BedrockAgentCoreApp()

MEMORY_ID = os.environ.get('MEMORY_ID', '')
_memory_client = MemoryClient() if MEMORY_ID else None


def _get_actor_id() -> str:
    """Cognito JWTのsubをactor_idとして返す（AgentCoreが検証済みのトークンを利用）"""
    token = BedrockAgentCoreContext.get_workload_access_token()
    if not token:
        return 'anonymous'
    try:
        payload = token.split('.')[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += '=' * padding
        claims = json.loads(base64.b64decode(payload))
        return claims.get('sub', 'anonymous')
    except Exception:
        return 'anonymous'


def convert_event(event) -> dict | None:
    """Strandsのイベントをフロントエンド向けJSON形式に変換"""
    try:
        if not hasattr(event, 'get'):
            return None

        inner_event = event.get('event')
        if not inner_event:
            return None

        content_block_delta = inner_event.get('contentBlockDelta')
        if content_block_delta:
            delta = content_block_delta.get('delta', {})
            text = delta.get('text')
            if text:
                return {'type': 'text', 'data': text}

        content_block_start = inner_event.get('contentBlockStart')
        if content_block_start:
            start = content_block_start.get('start', {})
            tool_use = start.get('toolUse')
            if tool_use:
                tool_name = tool_use.get('name', 'unknown')
                return {'type': 'tool_use', 'tool_name': tool_name}

        return None
    except Exception:
        return None


def _load_history(actor_id: str, session_id: str) -> list:
    """STMから会話履歴を読み込み、Strands形式に変換"""
    if not _memory_client or not actor_id or not session_id:
        return []
    try:
        turns = _memory_client.get_last_k_turns(
            memory_id=MEMORY_ID,
            actor_id=actor_id,
            session_id=session_id,
            k=10,
        )
        messages = []
        for turn in turns:
            for msg in turn:
                role = msg.get('role', '').upper()
                text = msg.get('content', {}).get('text', '')
                if role == 'USER':
                    messages.append({'role': 'user', 'content': [{'text': text}]})
                elif role == 'ASSISTANT':
                    messages.append({'role': 'assistant', 'content': [{'text': text}]})
        return messages
    except Exception:
        return []


def _save_turn(actor_id: str, session_id: str, prompt: str, response: str) -> None:
    """STMに今回の会話ターンを保存"""
    if not _memory_client or not actor_id or not session_id or not prompt or not response:
        return
    try:
        _memory_client.create_event(
            memory_id=MEMORY_ID,
            actor_id=actor_id,
            session_id=session_id,
            messages=[(prompt, 'USER'), (response, 'ASSISTANT')],
        )
    except Exception:
        pass


@app.entrypoint
async def invoke_agent(payload, context):

    prompt = payload.get("prompt", "")
    session_id = context.session_id or ""
    actor_id = _get_actor_id()

    # STMから会話履歴を取得してエージェントの初期メッセージに設定
    history = _load_history(actor_id, session_id)

    agent = Agent(
        model="global.amazon.nova-2-lite-v1:0",
        system_prompt="aws.amazon.com/about-aws/whats-new/recent/feed からRSSを取得して",
        tools=[rss],
        messages=history,
    )

    # ストリーミングしながら応答テキストを収集
    response_chunks: list[str] = []
    async for event in agent.stream_async(prompt):
        converted = convert_event(event)
        if converted:
            if converted['type'] == 'text':
                response_chunks.append(converted['data'])
            yield converted

    # 今回のターンをSTMに保存
    _save_turn(actor_id, session_id, prompt, ''.join(response_chunks))


if __name__ == "__main__":
    app.run()
