import { generateVTASVG, type SVGExportOptions } from './svgExport';
import {
  buildCausalFlowSequence,
  buildPipelineEvolutionSequence,
  computeSVGPathLength,
  type AnimationMode,
  type AnimationSequence,
} from './animationSequencer';
import type { VTASchema, VTAReactFlowNode, VTAReactFlowEdge } from '../../../types/vta';
import type { LayoutResult } from './layout';

export interface AnimatedSVGOptions extends SVGExportOptions {
  animationMode?: AnimationMode;
  mode?: AnimationMode; // alias for animationMode
  loopCycleSeconds?: number;
  holdSeconds?: number;
}

/**
 * Parses generated SVG string to extract accurate path lengths for all rendered edges.
 */
function extractEdgePathLengthsFromSVG(svg: string): Map<string, number> {
  const lengths = new Map<string, number>();
  const edgeRegex = /<g id="(edge_[^"]+)"[^>]*>[\s\S]*?<path d="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = edgeRegex.exec(svg)) !== null) {
    const edgeId = match[1];
    const pathD = match[2];
    lengths.set(edgeId, computeSVGPathLength(pathD));
  }
  return lengths;
}

/**
 * Generates an Animated Vector SVG containing pure declarative CSS @keyframes.
 * Zero external scripts or dependencies; 100% compatible with browsers, PowerPoint, and Markdown.
 */
export function generateAnimatedVTASVG(
  vtaData: VTASchema,
  nodes: VTAReactFlowNode[],
  edges: VTAReactFlowEdge[],
  laneBounds?: LayoutResult['laneBounds'],
  options: AnimatedSVGOptions = {}
): string {
  const mode: AnimationMode = options.animationMode ?? options.mode ?? 'causal_flow';

  // Step 1: Generate static baseline SVG
  const baseSVG = generateVTASVG(vtaData, nodes, edges, laneBounds ?? [], {
    ...options,
    includeHeader: options.includeHeader ?? true,
  });

  // Step 2: Extract rendered edge path lengths for exact line-draw animation
  const edgeLengths = extractEdgePathLengthsFromSVG(baseSVG);

  // Step 3: Compute animation sequence and timing
  const sequence: AnimationSequence = mode === 'causal_flow'
    ? buildCausalFlowSequence(vtaData, edgeLengths, {
        holdSeconds: options.holdSeconds ?? 4.0,
      })
    : buildPipelineEvolutionSequence(vtaData, {
        holdSeconds: options.holdSeconds ?? 4.0,
      });

  const T = sequence.cycleDuration;
  const holdStartPct = Math.round((sequence.totalDuration / T) * 1000) / 10;
  const fadeStartPct = 96.0;
  const endPct = 100.0;

  // Step 4: Build CSS @keyframes
  const cssRules: string[] = [];

  // Base setup
  cssRules.push(`
    /* ================= VTA ANIMATED SVG STYLES ================= */
    @keyframes vtaFadeInSwimlanes {
      0% { opacity: 0; }
      4%, ${fadeStartPct}% { opacity: 1; }
      ${endPct}% { opacity: 0; }
    }
    #swimlanes, #time-axis {
      animation: vtaFadeInSwimlanes ${T}s infinite ease-out;
    }
  `);

  if (mode === 'causal_flow') {
    // Generate keyframes for each node
    sequence.nodeTimings.forEach((timing, nodeId) => {
      const pStart = Math.max(0, Math.round((timing.startTime / T) * 1000) / 10);
      const pIn = Math.min(fadeStartPct, Math.round((timing.endTime / T) * 1000) / 10);

      const animName = `anim_node_${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      let popKeyframe = `
      @keyframes ${animName} {
        0%, ${pStart}% {
          opacity: 0;
          transform: scale(0.85);
          pointer-events: none;
        }
        ${pIn}%, ${fadeStartPct}% {
          opacity: 1;
          transform: scale(1);
          pointer-events: auto;
        }
        ${endPct}% {
          opacity: 0;
          transform: scale(0.85);
        }
      }`;

      // Extra highlight for variation and outcome
      if (timing.isVariation) {
        popKeyframe += `
      #${nodeId} rect {
        animation: vtaPulseAmber ${T}s infinite ease-in-out;
      }`;
      } else if (timing.isOutcome) {
        popKeyframe += `
      #${nodeId} rect {
        animation: vtaPulseRose ${T}s infinite ease-in-out;
      }`;
      }

      cssRules.push(popKeyframe);
      cssRules.push(`
      #${nodeId} {
        transform-origin: center;
        animation: ${animName} ${T}s infinite ease-out;
      }`);
    });

    // Generate keyframes for each edge
    sequence.edgeTimings.forEach((timing, rawEdgeId) => {
      const edgeElementId = rawEdgeId.startsWith('edge_') ? rawEdgeId : `edge_${rawEdgeId}`;
      const pathLength = edgeLengths.get(edgeElementId) ?? timing.pathLength ?? 150;

      const pStart = Math.max(0, Math.round((timing.startTime / T) * 1000) / 10);
      const pIn = Math.min(fadeStartPct, Math.round((timing.endTime / T) * 1000) / 10);
      const animName = `anim_${edgeElementId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      const edgeKeyframe = `
      @keyframes ${animName} {
        0%, ${pStart}% {
          stroke-dashoffset: ${pathLength};
          opacity: 0;
        }
        ${Math.min(fadeStartPct, pStart + 0.5)}% {
          opacity: 1;
        }
        ${pIn}%, ${fadeStartPct}% {
          stroke-dashoffset: 0;
          opacity: 1;
        }
        ${endPct}% {
          stroke-dashoffset: ${pathLength};
          opacity: 0;
        }
      }
      #${edgeElementId} path {
        stroke-dasharray: ${pathLength};
        stroke-dashoffset: ${pathLength};
        animation: ${animName} ${T}s infinite linear;
      }
      #${edgeElementId} g {
        animation: ${animName} ${T}s infinite ease-out;
      }`;

      cssRules.push(edgeKeyframe);
    });

    // Amber and Rose pulse keyframes
    cssRules.push(`
    @keyframes vtaPulseAmber {
      0%, 20%, 80%, 100% { filter: url(#variation-shadow); stroke: #d97706; }
      50% { filter: drop-shadow(0 0 10px rgba(245, 158, 11, 0.9)); stroke: #b45309; }
    }
    @keyframes vtaPulseRose {
      0%, 20%, 80%, 100% { filter: url(#variation-shadow); stroke: #e11d48; }
      50% { filter: drop-shadow(0 0 12px rgba(225, 29, 72, 0.9)); stroke: #9f1239; }
    }
    `);
  } else {
    // Mode 2: Pipeline Evolution
    const stepSeconds = sequence.totalDuration / 4;
    const p1 = Math.round((stepSeconds / T) * 1000) / 10;
    const p2 = Math.round(((stepSeconds * 2) / T) * 1000) / 10;
    const p3 = Math.round(((stepSeconds * 3) / T) * 1000) / 10;

    cssRules.push(`
    /* Stage 1..4 Evolution */
    @keyframes vtaAnimPipelineEdges {
      0%, ${p2}% { opacity: 0; }
      ${p2 + 2}%, ${fadeStartPct}% { opacity: 1; }
      ${endPct}% { opacity: 0; }
    }
    #vta-edges {
      animation: vtaAnimPipelineEdges ${T}s infinite ease-out;
    }
    @keyframes vtaAnimPipelineColoring {
      0%, ${p3}% { filter: grayscale(90%) contrast(90%); }
      ${p3 + 3}%, ${fadeStartPct}% { filter: none; }
      ${endPct}% { filter: grayscale(90%) contrast(90%); }
    }
    #vta-nodes {
      animation: vtaAnimPipelineColoring ${T}s infinite ease-out;
    }
    @keyframes vtaPulseAmber {
      0%, 20%, 80%, 100% { filter: url(#variation-shadow); stroke: #d97706; }
      50% { filter: drop-shadow(0 0 10px rgba(245, 158, 11, 0.9)); stroke: #b45309; }
    }
    @keyframes vtaPulseRose {
      0%, 20%, 80%, 100% { filter: url(#variation-shadow); stroke: #e11d48; }
      50% { filter: drop-shadow(0 0 12px rgba(225, 29, 72, 0.9)); stroke: #9f1239; }
    }
    `);
  }

  // Step 5: Inject CSS style block into SVG <defs>
  const styleBlock = `
    <style type="text/css">
      <![CDATA[
      ${cssRules.join('\n')}
      ]]>
    </style>
  `;

  let injectedSVG = baseSVG.replace('</defs>', `${styleBlock}\n  </defs>`);

  const replayBadge = mode === 'causal_flow'
    ? '【因果リプレイ】'
    : '【AI推論進化リプレイ】';

  if (injectedSVG.includes('バリエーションツリー (VTA) 分析図')) {
    injectedSVG = injectedSVG.replace(
      'バリエーションツリー (VTA) 分析図',
      `バリエーションツリー (VTA) 分析図 ${replayBadge}`
    );
  }

  return injectedSVG;
}

/**
 * Triggers client-side download of the Animated VTA diagram as a single SVG file.
 */
export function exportAnimatedVTAToSVGFile(
  vtaData: VTASchema,
  nodes: VTAReactFlowNode[],
  edges: VTAReactFlowEdge[],
  laneBounds?: LayoutResult['laneBounds'],
  options: AnimatedSVGOptions = {}
): { success: boolean; filename: string } {
  try {
    const svgContent = generateAnimatedVTASVG(vtaData, nodes, edges, laneBounds, options);
    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    const defaultFilename = `vta-animated-${options.animationMode ?? options.mode ?? 'causal_flow'}-${new Date().toISOString().slice(0, 10)}.svg`;
    const finalFilename = options.filename?.trim() ? options.filename.trim() : defaultFilename;

    link.href = url;
    link.download = finalFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    return { success: true, filename: finalFilename };
  } catch (err) {
    console.error('Failed to export animated SVG file:', err);
    throw err;
  }
}
