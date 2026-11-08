// chatIdentity — 消息头里那两个名字：用户轮 = 账号用户名，助手轮 = 桌宠名字。
//
// 两个真源都在 settings.json，渲染层不另存副本（否则设置页与消息头各说各话）：
//   desktopAccountName  账号用户名，默认「本地用户」，设置 → 常规 → 账号 可改
//   desktopPetName      自定义桌宠名；留空则按 desktopPetCharacter 从角色表拼出
//                       「khy · 澪 · 引导者」/「khy · 凯 · 首席工程师」/「khy · 锦鲤 · 好运使者」
//
// 改名要立刻反映到已经渲染出来的消息头上，所以走两条窗口广播：
//   khy:identity       IdentityPatch —— 设置页改完名字后派发
//   khy:pet-character  角色 id —— 设置页或桌宠卡片换人后派发，派生名跟着换
// 自定义名优先于角色派生名：用户给桌宠起过名，换角色也不该把它盖掉。

import { useEffect, useState } from 'react'
import fortuneJson from '@/assets/pet/pet-fortune.json'
import type { PetCharacterId, PetFortuneData } from '../components/pet/petFortune'

const fortune = fortuneJson as unknown as PetFortuneData

export const ACCOUNT_NAME_SETTING = 'desktopAccountName'
export const PET_NAME_SETTING = 'desktopPetName'
export const PET_CHARACTER_SETTING = 'desktopPetCharacter'
export const DEFAULT_ACCOUNT_NAME = '本地用户'

export interface ChatIdentity {
  userName: string
  assistantName: string
}

export interface IdentityPatch {
  userName?: string
  assistantName?: string
  /** assistantName 是用户自己起的（true）还是角色表派生的（false）。 */
  customPet?: boolean
}

type SettingsLike = Record<string, unknown>

function isCharacterId(value: unknown): value is PetCharacterId {
  return value === 'female' || value === 'male' || value === 'koi'
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function petDisplayName(settings: SettingsLike): string {
  const custom = trimmedString(settings[PET_NAME_SETTING])
  if (custom) return custom
  const raw = settings[PET_CHARACTER_SETTING]
  const character = fortune.characters[isCharacterId(raw) ? raw : 'female']
  return `khy · ${character.name} · ${character.title}`
}

export function accountDisplayName(settings: SettingsLike): string {
  return trimmedString(settings[ACCOUNT_NAME_SETTING]) || DEFAULT_ACCOUNT_NAME
}

/** 改完某个设置键之后，把它换算成一条广播补丁；与这两个名字无关的键返回空补丁。 */
export function identityPatchFor(settings: SettingsLike, key: string, value: unknown): IdentityPatch {
  const next = { ...settings, [key]: value }
  if (key === ACCOUNT_NAME_SETTING) return { userName: accountDisplayName(next) }
  if (key === PET_NAME_SETTING) {
    return { assistantName: petDisplayName(next), customPet: trimmedString(value) !== '' }
  }
  return {}
}

let cached: ChatIdentity = {
  userName: DEFAULT_ACCOUNT_NAME,
  assistantName: petDisplayName({}),
}
let customPet = false
let loaded = false
let inflight: Promise<void> | null = null
const listeners = new Set<(identity: ChatIdentity) => void>()

function publish(next: ChatIdentity): void {
  cached = next
  for (const listener of listeners) listener(next)
}

function adoptSettings(settings: SettingsLike): void {
  customPet = trimmedString(settings[PET_NAME_SETTING]) !== ''
  publish({
    userName: accountDisplayName(settings),
    assistantName: petDisplayName(settings),
  })
}

function load(): void {
  if (loaded || inflight) return
  const api = (window as unknown as {
    __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
  }).__KHYOS__
  if (!api?.getSettings) {
    loaded = true
    return
  }
  inflight = api
    .getSettings()
    .then((settings) => {
      loaded = true
      adoptSettings(settings || {})
    })
    .catch(() => {
      // 读不到就保持默认名：宁可显示「本地用户」，也不显示空白。
      loaded = true
    })
    .finally(() => {
      inflight = null
    })
}

function onIdentityEvent(event: Event): void {
  const patch = (event as CustomEvent<IdentityPatch>).detail
  if (!patch) return
  if (patch.customPet !== undefined) customPet = patch.customPet
  publish({
    userName: patch.userName ?? cached.userName,
    assistantName: patch.assistantName ?? cached.assistantName,
  })
}

function onCharacterEvent(event: Event): void {
  const id = (event as CustomEvent<unknown>).detail
  if (!isCharacterId(id) || customPet) return
  publish({ ...cached, assistantName: petDisplayName({ [PET_CHARACTER_SETTING]: id }) })
}

let wired = false

function wireEvents(): void {
  if (wired) return
  wired = true
  window.addEventListener('khy:identity', onIdentityEvent)
  window.addEventListener('khy:pet-character', onCharacterEvent)
}

/** 设置页改完名字后调用：拿到设置页手里的 settings，换算成广播补丁。 */
export function broadcastIdentity(settings: SettingsLike, key: string, value: unknown): void {
  const patch = identityPatchFor(settings, key, value)
  if (patch.userName === undefined && patch.assistantName === undefined) return
  window.dispatchEvent(new CustomEvent<IdentityPatch>('khy:identity', { detail: patch }))
}

export function useChatIdentity(): ChatIdentity {
  const [identity, setIdentity] = useState<ChatIdentity>(cached)
  useEffect(() => {
    wireEvents()
    listeners.add(setIdentity)
    load()
    // 挂载与订阅之间设置可能已经读完，补一次快照，免得停在默认名上。
    setIdentity(cached)
    return () => {
      listeners.delete(setIdentity)
    }
  }, [])
  return identity
}
