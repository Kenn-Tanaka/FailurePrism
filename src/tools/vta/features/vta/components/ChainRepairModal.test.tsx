import React from 'react';
import {it,expect,afterEach,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChainRepairModal} from './ChainRepairModal';
import {useVTAStore} from '../store/vtaStore';
// SSR uses Zustand's initial snapshot; expose the current snapshot for these state-specific renders.
vi.mock('../store/vtaStore',async importOriginal=>{
 const actual=await importOriginal<typeof import('../store/vtaStore')>();
 return {...actual,useVTAStore:Object.assign(()=>actual.useVTAStore.getState(),actual.useVTAStore)};
});
afterEach(()=>useVTAStore.setState({isProposing:false}));
it('exposes close, cancel and start controls as an accessible dialog before candidates exist',()=>{
 const html=renderToStaticMarkup(<ChainRepairModal onClose={()=>{}}/>);
 expect(html).toContain('role="dialog"');expect(html).toContain('aria-modal="true"');
 expect(html).toMatch(/<button[^>]*>閉じる<\/button>/);
 expect(html).toMatch(/<button[^>]*>キャンセルして戻る<\/button>/);
 expect(html).toMatch(/<button[^>]*>全文から点検する<\/button>/);
 expect(html).toContain('先に「全文から点検する」を押してください。');
 expect(html).toMatch(/<button[^>]*disabled=""[^>]*>選択した差分を一括適用<\/button>/);
});
it('leaves return controls enabled while another operation prevents generation',()=>{
 useVTAStore.setState({isProposing:true});
 const html=renderToStaticMarkup(<ChainRepairModal onClose={()=>{}}/>);
 expect(html).toMatch(/<button[^>]*disabled=""[^>]*>全文から点検する<\/button>/);
 expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>閉じる<\/button>/);
 expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>キャンセルして戻る<\/button>/);
});
