import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it} from 'vitest';
import {DebugRecordingControls} from './DebugRecordingControls';
import {debugRecorder} from '../../services/debugRecorder';
afterEach(()=>{debugRecorder.setEnabled(false);debugRecorder.clear();});
it('shows the opt-in checkbox and explicit OFF state without a recording badge by default',()=>{
 const html=renderToStaticMarkup(<DebugRecordingControls/>);
 expect(html).toContain('type="checkbox"');expect(html).not.toContain('checked=""');expect(html).toContain('記録OFF');
 expect(html).toContain('デバッグログを保存');expect(html).toContain('メモリ内のみ');
 expect(renderToStaticMarkup(<DebugRecordingControls compact/>)).toBe('');
});
it('shows recording state in both the controls and the persistent stop button',()=>{
 debugRecorder.setEnabled(true);debugRecorder.record('test',()=>({}));
 const html=renderToStaticMarkup(<DebugRecordingControls/>),badge=renderToStaticMarkup(<DebugRecordingControls compact/>);
 expect(html).toContain('checked=""');expect(html).toContain('記録中');expect(html).toContain('1件');
 expect(badge).toContain('デバッグ記録中・停止');expect(badge).toContain('<button');
});
