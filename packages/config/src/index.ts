import { clinicPreset } from './presets/clinic.ts';
import { realEstatePreset } from './presets/real-estate.ts';
import type { TenantConfig } from './schema.ts';

export * from './llm.ts';
export * from './schema.ts';
export * from './templates.ts';
export * from './validate.ts';
export { CLINIC_VARIANTS, clinicPreset, type ClinicVariant } from './presets/clinic.ts';
export { realEstatePreset } from './presets/real-estate.ts';

export const PRESETS = {
  clinic_dental: (name?: string) => clinicPreset('dental', name),
  clinic_skin: (name?: string) => clinicPreset('skin', name),
  clinic_hair: (name?: string) => clinicPreset('hair', name),
  real_estate: (name?: string) => realEstatePreset(name),
} satisfies Record<string, (businessName?: string) => TenantConfig>;

export type PresetKey = keyof typeof PRESETS;
export const PRESET_KEYS = Object.keys(PRESETS) as PresetKey[];
