import type {VTAParticipation} from '../../../types/vta';
/** Legacy metadata is readable, but new assignments need only a boolean marker. */
export const isSubjectInferred=(part:VTAParticipation)=>part.inferred??part.evidenceBasis==='source-context';
