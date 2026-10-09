'use client';

import { useEffect, useRef, useState } from 'react';
import { tokenize } from '../lib/code-tokens.mjs';

export default function CodeWindow({ title, code }) {
  const [label, setLabel] = useState('คัดลอก');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setLabel('คัดลอกแล้ว'); }
    catch { setLabel('คัดลอกไม่ได้'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel('คัดลอก'), 1400);
  }
  const lines = code.replace(/\n$/, '').split('\n').length;
  return <div className="cw" data-lang="js">
    <div className="cw-bar">
      <span className="cw-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="cw-tab"><span className="cw-file">{title}</span></span>
      <button type="button" className="cw-copy" onClick={copy} aria-live="polite">{label}</button>
    </div>
    <div className="cw-body"><div className="cw-gutter" aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
      <pre><code>{tokenize(code, 'js').map((token, index) => token.type ? <span className={`tk-${token.type}`} key={index}>{token.text}</span> : token.text)}</code></pre>
    </div>
    <div className="cw-status" aria-hidden="true"><span>Ln {lines}</span><span>UTF-8</span><span className="cw-lang">JavaScript</span></div>
  </div>;
}
