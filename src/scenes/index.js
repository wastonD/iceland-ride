// Scene registry. ?scene=<id> picks one; default is the last one the user chose.
import { t } from '../core/i18n.js';
export const SCENES = {
  rainforest: { get name() { return t('scene.rainforest'); }, load: () => import('./rainforest.js') },
  fjord: { get name() { return t('scene.fjord'); }, load: () => import('./fjord/scene.js') },
};
export const DEFAULT_SCENE = 'fjord';
