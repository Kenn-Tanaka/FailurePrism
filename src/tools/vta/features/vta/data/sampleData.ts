import { VTASchema } from '../../../types/vta';

export interface SampleScenario {
  id: string;
  title: string;
  scenarioText: string;
  vtaData: VTASchema;
}

/**
 * 製品初期状態は常にクリア（空）とするため、組み込みサンプル事例は保持しない。
 */
export const SAMPLE_SCENARIOS: SampleScenario[] = [];
