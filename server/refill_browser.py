"""Optional Browser Use driver. Only visits the synthetic local test pharmacy."""
import asyncio
import os
import sys
from urllib.parse import urlparse
from browser_use import Agent, Browser, ChatBrowserUse


async def main():
    request_id, stage = sys.argv[1:]
    if stage not in ('prepare', 'place') or not request_id or not all(c.isalnum() or c == '-' for c in request_id):
        raise ValueError('Invalid refill command')
    origin = os.environ.get('HALO_TEST_PHARMACY_ORIGIN', 'http://127.0.0.1:8787')
    parsed = urlparse(origin)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.path not in ('', '/'):
        raise ValueError('Only the local test pharmacy is supported')
    url = f'{origin.rstrip("/")}/test-pharmacy/refills/{request_id}'
    instruction = (
        'Click Prepare refill quote once. Stop when status is awaiting_approval. Never approve or place an order.'
        if stage == 'prepare' else
        'Family approval is already recorded by HALO. Click Place approved test order once. '
        'Stop when a TEST- order ID appears. If no button is visible, stop and report the status.'
    )
    browser = Browser(headless=True, allowed_domains=[origin])
    try:
        agent = Agent(task=f'Open {url}. Synthetic local pharmacy demo. {instruction} '
                      'Stay on this site. Do not change URLs or enter payment information.',
                      llm=ChatBrowserUse(), browser=browser)
        await agent.run(max_steps=12)
    finally:
        await browser.stop()


if __name__ == '__main__':
    asyncio.run(main())
