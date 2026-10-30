import {it,expect} from 'vitest';
import {parseChainDelta,applyChainDelta} from './chainRepair';
import {inspectLedger,parseLedger} from './eventLedger';
import {ledgerFixture,ledgerSource} from './eventLedger.fixture';
import {sourceFromText,projectAnalysis} from './eventAnalysis';
import {connectionProposalSignature} from './connectionProposals';
import {useVTAStore} from '../store/vtaStore';
const schema=()=>projectAnalysis(inspectLedger(parseLedger(ledgerFixture()),sourceFromText(ledgerSource)).analysis!);
const text='[追加主体]\n[追加イベント]\ntmp_e\t-\t記録の再確認\t停止後に装置の記録を再確認\tsource_1/p2\trecorded\t原文の記録\n[割当追加]\nP1\ttmp_e\tA2\tactor\tsource_1/p2\t-\n[関係追加]\ntmp_r\tdependency\tE1\tA1\ttmp_e\tA2\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\t先行状態を使用\n[要確認]\n[完了]';
it('previews dependent additions without mutating the graph and rejects an orphan line selection',()=>{
 const original=schema(),snapshot=JSON.stringify(original),rows=parseChainDelta(text);
 expect(applyChainDelta(original,rows).analysis?.events.some(e=>e.id==='tmp_e')).toBe(true);
 expect(JSON.stringify(original)).toBe(snapshot);
 expect(()=>applyChainDelta(original,rows.filter(r=>r.section==='関係追加'))).toThrow();
 expect(()=>applyChainDelta(original,parseChainDelta(text.replace('source_1/p1,source_1/p2','source_1/missing')))).toThrow('原文');
});
it('adopts all additions as one reversible change through the real store',()=>{
 const s=schema();expect(useVTAStore.getState().importProjectJSON(JSON.stringify({version:'5.0',savedAt:new Date().toISOString(),scenarioText:ledgerSource,vtaData:s})).success).toBe(true);
 const before=useVTAStore.getState().vtaData,signature=connectionProposalSignature(before);
 const applied=applyChainDelta(before,parseChainDelta(text),true);
 useVTAStore.getState().commitVTAChange({schema:applied,preserveDerivedRemovals:true});
 expect(useVTAStore.getState().vtaData.analysis?.events).toHaveLength(3);
 expect(useVTAStore.getState().vtaData.edges.some(e=>e.meaning==='dependency')).toBe(true);
 useVTAStore.getState().undo();expect(connectionProposalSignature(useVTAStore.getState().vtaData)).toBe(signature);
 useVTAStore.getState().redo();expect(useVTAStore.getState().vtaData.analysis?.events).toHaveLength(3);
});
it('rejects incomplete transport and duplicate additions',()=>{
 expect(()=>parseChainDelta(text.replace('[完了]',''))).toThrow();
 expect(()=>applyChainDelta(schema(),parseChainDelta(text.replace('tmp_e\t-','E1\t-')))).toThrow();
});
