import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { VTAReactFlowNode } from '../../../types/vta';
import { JUNCTION_SIZE, JUNCTION_RADIUS } from '../utils/nodeGeometry';

const ports = [
  ['top', 'source', Position.Top], ['bottom', 'target', Position.Bottom],
  ['left-source', 'source', Position.Left], ['left-target', 'target', Position.Left],
  ['right-source', 'source', Position.Right], ['right-target', 'target', Position.Right],
] as const;

export const VTAJunctionNode: React.FC<NodeProps<VTAReactFlowNode>> = ({ data, selected }) => (
  <div title={`${data.title}（図上は接続点）— クリックで説明欄を表示`}
    aria-label={`${data.title}：接続点`} style={{ width: JUNCTION_SIZE, height: JUNCTION_SIZE }}
    className="relative cursor-pointer">
    {ports.map(([id, type, position]) => <Handle key={id} id={id} type={type} position={position}
      isConnectable={false} style={{ left: '50%', top: '50%', right: 'auto', bottom: 'auto',
        width: 1, height: 1, transform: 'translate(-50%, -50%)', opacity: 0, pointerEvents: 'none' }} />)}
    <span style={{ width: JUNCTION_RADIUS * 2, height: JUNCTION_RADIUS * 2 }}
      className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-200 ${selected ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950' : ''}`} />
  </div>
);
