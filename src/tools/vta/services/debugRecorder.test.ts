import {describe,it,expect,vi} from 'vitest';
import {createDebugRecorder} from './debugRecorder';
describe('opt-in debug recorder',()=>{
 it('starts OFF, avoids even building payloads, and stops retaining events when OFF',()=>{
  const recorder=createDebugRecorder(),payload=vi.fn(()=>({text:'source'}));
  recorder.record('ignored',payload);expect(payload).not.toHaveBeenCalled();
  recorder.setEnabled(true);recorder.record('captured',payload);recorder.setEnabled(false);recorder.record('ignored',payload);
  expect(payload).toHaveBeenCalledTimes(1);expect(recorder.getSnapshot().count).toBe(1);
  expect(JSON.parse(recorder.exportText()).entries[0].data.text).toBe('source');
 });
 it('rejects results from requests started in an older recording session, including after clear',()=>{
  const recorder=createDebugRecorder();recorder.setEnabled(true);const session=recorder.getSnapshot().sessionId;
  recorder.setEnabled(false);recorder.setEnabled(true);recorder.record('old',()=>({}),session);
  expect(recorder.getSnapshot().count).toBe(0);
  const second=recorder.getSnapshot().sessionId;recorder.clear();recorder.record('cleared',()=>({}),second);
  expect(recorder.getSnapshot().count).toBe(0);
 });
 it('redacts credentials and known tokens, even within escaped content',()=>{
  const recorder=createDebugRecorder();recorder.setEnabled(true);
  recorder.record('safe',()=>({gatewayToken:'private',nested:{Authorization:'Bearer private',api_key:'key'},text:'prefix abc"secret suffix Bearer xyz',url:'https://host/v1?api_key=urlkey'}),undefined,['abc"secret']);
  const exported=JSON.stringify(JSON.parse(recorder.exportText()).entries[0].data);for(const secret of ['private','abc','urlkey','Bearer xyz'])expect(exported).not.toContain(secret);
  expect(exported).toContain('[REDACTED]');
 });
 it('does not corrupt JSON while sanitizing URLs beside email-like content',()=>{
  const recorder=createDebugRecorder();recorder.setEnabled(true);
  recorder.record('urls',()=>({endpoint:'https://host',email:'user@example.test',credentials:'https://user:pass@host/v1'}));
  expect(recorder.getSnapshot().count).toBe(1);
  const data=JSON.parse(recorder.exportText()).entries[0].data;
  expect(data.endpoint).toBe('https://host');expect(data.email).toBe('user@example.test');expect(data.credentials).toBe('https://[REDACTED]@host/v1');
 });
 it('bounds memory, reports truncation and eviction, and exports valid JSON',()=>{
  const recorder=createDebugRecorder({entries:2,totalChars:2000,entryChars:80});recorder.setEnabled(true);
  recorder.record('large',()=>({text:'a'.repeat(500)}));expect(recorder.getSnapshot().truncated).toBe(1);
  recorder.record('two',()=>({}));recorder.record('three',()=>({}));
  expect(recorder.getSnapshot()).toMatchObject({count:2,dropped:1});expect(JSON.parse(recorder.exportText()).entries.map((e:{stage:string})=>e.stage)).toEqual(['two','three']);
  recorder.clear();expect(recorder.getSnapshot()).toMatchObject({enabled:true,count:0,dropped:0,truncated:0});
 });
 it('keeps snapshots stable between updates and does not fail the app on unserializable data',()=>{
  const recorder=createDebugRecorder(),listener=vi.fn();const unsubscribe=recorder.subscribe(listener);
  expect(recorder.getSnapshot()).toBe(recorder.getSnapshot());recorder.setEnabled(true);
  recorder.record('bad',()=>{throw Error('bad payload');});expect(recorder.getSnapshot().count).toBe(0);
  expect(listener).toHaveBeenCalledTimes(1);unsubscribe();recorder.setEnabled(false);expect(listener).toHaveBeenCalledTimes(1);
 });
});
