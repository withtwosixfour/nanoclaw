import { describe, it, expect } from 'vitest';

import {
  escapeXml,
  formatMessages,
  formatOutbound,
  stripReasoningTags,
} from './router.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats a single message as XML', () => {
    const result = formatMessages([makeMsg()]);
    expect(result).toBe(
      '<messages>\n' +
        '<message sender="Alice" time="2024-01-01T00:00:00.000Z">hello</message>\n' +
        '</messages>',
    );
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: 't1',
      }),
      makeMsg({ id: '2', sender_name: 'Bob', content: 'hey', timestamp: 't2' }),
    ];
    const result = formatMessages(msgs);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })]);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages([
      makeMsg({ content: '<script>alert("xss")</script>' }),
    ]);
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([]);
    expect(result).toBe('<messages>\n\n</messages>');
  });
});

// --- Outbound formatting (reasoning tag stripping + prefix) ---

describe('stripReasoningTags', () => {
  it('strips single-line reasoning tags', () => {
    expect(
      stripReasoningTags('hello <reasoning>secret</reasoning> world'),
    ).toBe('hello  world');
  });

  it('strips multi-line reasoning tags', () => {
    expect(
      stripReasoningTags(
        'hello <reasoning>\nsecret\nstuff\n</reasoning> world',
      ),
    ).toBe('hello  world');
  });

  it('strips multiple reasoning tag blocks', () => {
    expect(
      stripReasoningTags(
        '<reasoning>a</reasoning>hello<reasoning>b</reasoning>',
      ),
    ).toBe('hello');
  });

  it('returns empty string when text is only reasoning tags', () => {
    expect(stripReasoningTags('<reasoning>only this</reasoning>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with reasoning tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is reasoning', () => {
    expect(formatOutbound('<reasoning>hidden</reasoning>')).toBe('');
  });

  it('strips reasoning tags from remaining text', () => {
    expect(
      formatOutbound('<reasoning>thinking</reasoning>The answer is 42'),
    ).toBe('The answer is 42');
  });
});
