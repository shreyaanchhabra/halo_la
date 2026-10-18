import type { RefillData, TEST_CATALOG } from '../../../../shared/refills.ts'

export type State = RefillData & { catalog: typeof TEST_CATALOG; driver: string }
