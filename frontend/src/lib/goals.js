// The five things a client can be working towards, and how much training they have behind them.
//
// These lists are the client half of a contract with the server: GOALS and EXPERIENCE in
// api/server.js refuse anything that is not one of these exact strings, so a value added on one
// side and not the other is a 400 at the intake form. The labels are functions because `t()`
// reads the language pack at call time — a module-level string would freeze the language the
// app happened to boot in.
import { t } from './i18n.js'

export const GOALS = [
  { value: 'lose_weight', label: () => t('Lose body weight'), icon: 'scale' },
  { value: 'gain_weight', label: () => t('Gain body weight'), icon: 'plus' },
  { value: 'build_muscle', label: () => t('Build muscle'), icon: 'arm' },
  { value: 'get_stronger', label: () => t('Get stronger'), icon: 'barbell' },
  { value: 'general_fitness', label: () => t('General fitness'), icon: 'heart' },
]

export const EXPERIENCE = [
  { value: 'beginner', label: () => t('New to training') },
  { value: 'intermediate', label: () => t('Trained before') },
  { value: 'advanced', label: () => t('Training for years') },
]

// An unknown goal is shown as it came rather than dropped: a client whose coach is running a
// newer server should see *something* truthful where their goal belongs.
export const goalLabel = goal => GOALS.find(g => g.value === goal)?.label() || goal || t('Not set yet')
