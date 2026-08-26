export type MascaraGoal = 'VOLUME' | 'LENGTH' | 'SEPARATION' | 'NATURAL_LOOK';

export type WaterproofPreference = 'REQUIRED' | 'AVOID' | 'NO_PREFERENCE';
export type RemovalPreference = 'EASY_REQUIRED' | 'NO_PREFERENCE';

export type MascaraPreferenceInput =
  | {
      mode: 'PERSONALIZED';
      goals: MascaraGoal[];
      waterproof: WaterproofPreference;
      removal: RemovalPreference;
      sensitiveEyes: boolean;
      contactLenses: boolean;
      avoidedIngredients: string[];
    }
  | {
      mode: 'UNKNOWN_GOALS';
      waterproof: WaterproofPreference;
      removal: RemovalPreference;
      sensitiveEyes: boolean;
      contactLenses: boolean;
      avoidedIngredients: string[];
    };

export type MascaraBriefSnapshot = {
  schemaVersion: 1;
  goals: MascaraGoal[];
  waterproof: WaterproofPreference;
  removal: RemovalPreference;
  sensitiveEyes: boolean;
  contactLenses: boolean;
  avoidedIngredients: string[];
} & ({ mode: 'PERSONALIZED' } | { mode: 'UNKNOWN_GOALS'; goals: [] });

export interface SavedMascaraPreference {
  snapshot: MascaraBriefSnapshot;
  profileVersion: number;
  createdAt: Date;
}

export interface PreferencesRepository {
  currentMascaraPreference(
    accountId: string,
  ): Promise<SavedMascaraPreference | null>;
  saveMascaraPreference(
    accountId: string,
    snapshot: MascaraBriefSnapshot,
  ): Promise<SavedMascaraPreference | null>;
}
