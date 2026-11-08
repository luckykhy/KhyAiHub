// accountAvatar — 账号头像：原文件路径存 settings，渲染层按路径取 data URL。
//
// 真源仍是 settings.json 的 desktopAccountAvatar（空 = 用桌宠立绘的默认头像）。
// 默认头像跟随桌宠角色（desktopPetCharacter）：换角色，侧栏与设置页的圈跟着换人，
// 不再是名字首字母。
// 渲染层不能直接 <img src="file://…">：页面本身就跑在 file:// 上，dev 下又是
// http://localhost，两种形态都会被当成跨源。所以统一走 main 的
// fs:readImageDataUrl（20MB 上限、按扩展名定 MIME，GIF 会照常动）。
//
// 侧栏与设置页各挂一个头像圈，两处都读同一份设置：改完派发
// khy:account-avatar 广播，另一个已挂载的圈立刻跟着换，不必等重新挂载。

import { useCallback, useEffect, useRef, useState } from 'react'
import femaleArt from '@/assets/pet/khy-pet-female-idle-cutout.png'
import maleArt from '@/assets/pet/khy-pet-male-idle-cutout.png'
import koiArt from '@/assets/pet/khy-pet-koi-idle-cutout.png'
import type { PetCharacterId } from '../components/pet/petFortune'

export const ACCOUNT_AVATAR_SETTING = 'desktopAccountAvatar'

const PET_CHARACTER_SETTING = 'desktopPetCharacter'

/** 默认头像 = 桌宠本人的立绘（与桌宠卡片同一张抠图，换角色即换脸）。 */
const PET_AVATAR_ART: Record<PetCharacterId, string> = {
  female: femaleArt,
  male: maleArt,
  koi: koiArt,
}

function isCharacterId(value: unknown): value is PetCharacterId {
  return value === 'female' || value === 'male' || value === 'koi'
}

export interface AvatarActionResult {
  ok: boolean
  /** 用户在文件对话框里点了取消 —— 不是失败，调用方不该报错。 */
  canceled?: boolean
  error?: string
}

export interface AccountAvatarState {
  path: string
  dataUrl: string
  /** 没有自选头像时显示的桌宠立绘；自选头像读失败也回落到它。 */
  defaultUrl: string
  error: string
  pick: () => Promise<AvatarActionResult>
  clear: () => Promise<AvatarActionResult>
}

interface AvatarBridge {
  getSettings?: () => Promise<Record<string, unknown>>
  setSetting?: (key: string, value: unknown) => Promise<boolean>
  selectFiles?: (filters?: { name: string; extensions: string[] }[]) => Promise<{ path: string; size: number }[]>
  readImageDataUrl?: (path: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
}

function bridge(): AvatarBridge | undefined {
  return (window as unknown as { __KHYOS__?: AvatarBridge }).__KHYOS__
}

const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']

export function useAccountAvatar(): AccountAvatarState {
  const [state, setState] = useState({ path: '', dataUrl: '', error: '' })
  const [characterId, setCharacterId] = useState<PetCharacterId>('female')
  const mounted = useRef(true)

  const load = useCallback(async (path: string) => {
    if (!path) {
      if (mounted.current) setState({ path: '', dataUrl: '', error: '' })
      return
    }
    const read = bridge()?.readImageDataUrl
    if (!read) {
      if (mounted.current) {
        setState({ path, dataUrl: '', error: '头像预览不可用：preload 未注入 readImageDataUrl，请重启应用' })
      }
      return
    }
    try {
      const result = await read(path)
      if (!mounted.current) return
      setState(
        result?.ok && result.dataUrl
          ? { path, dataUrl: result.dataUrl, error: '' }
          : { path, dataUrl: '', error: result?.error || `头像读取失败：${path}` },
      )
    } catch (err) {
      if (!mounted.current) return
      // 文件被移走/权限不足时回落到桌宠立绘，错误留给设置面展示，不静默空白。
      setState({
        path,
        dataUrl: '',
        error: `头像读取失败：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const api = bridge()
    void api?.getSettings?.().then((settings) => {
      const path = typeof settings?.[ACCOUNT_AVATAR_SETTING] === 'string'
        ? (settings[ACCOUNT_AVATAR_SETTING] as string)
        : ''
      const character = settings?.[PET_CHARACTER_SETTING]
      if (isCharacterId(character) && mounted.current) setCharacterId(character)
      void load(path)
    }).catch(() => {
      // 读不到设置就用默认角色立绘：头像不该拖垮侧栏。
    })

    const onAvatarChanged = (event: Event) => {
      const path = (event as CustomEvent<unknown>).detail
      void load(typeof path === 'string' ? path : '')
    }
    // 桌宠卡片或设置页换角色时也派发这条广播：默认头像跟着换人。
    const onCharacterChanged = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail
      if (mounted.current && isCharacterId(id)) setCharacterId(id)
    }
    window.addEventListener('khy:account-avatar', onAvatarChanged)
    window.addEventListener('khy:pet-character', onCharacterChanged)
    return () => {
      mounted.current = false
      window.removeEventListener('khy:account-avatar', onAvatarChanged)
      window.removeEventListener('khy:pet-character', onCharacterChanged)
    }
  }, [load])

  const pick = useCallback(async (): Promise<AvatarActionResult> => {
    const api = bridge()
    if (!api?.selectFiles) {
      return { ok: false, error: '换头像不可用：preload 未注入文件选择通道，请重启应用' }
    }
    try {
      const picked = await api.selectFiles([{ name: '头像图片 / 动态图', extensions: AVATAR_EXTENSIONS }])
      if (!picked?.length) return { ok: false, canceled: true }
      const path = picked[0].path
      const result = await api.readImageDataUrl?.(path)
      if (!result?.ok || !result.dataUrl) {
        return { ok: false, error: result?.error || `头像读取失败：${path}` }
      }
      await api.setSetting?.(ACCOUNT_AVATAR_SETTING, path)
      if (mounted.current) setState({ path, dataUrl: result.dataUrl, error: '' })
      window.dispatchEvent(new CustomEvent<string>('khy:account-avatar', { detail: path }))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `换头像失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }, [])

  const clear = useCallback(async (): Promise<AvatarActionResult> => {
    const api = bridge()
    if (!api?.setSetting) {
      return { ok: false, error: '恢复默认头像不可用：preload 未注入设置通道，请重启应用' }
    }
    try {
      await api.setSetting(ACCOUNT_AVATAR_SETTING, '')
      if (mounted.current) setState({ path: '', dataUrl: '', error: '' })
      window.dispatchEvent(new CustomEvent<string>('khy:account-avatar', { detail: '' }))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `恢复默认头像失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }, [])

  return { ...state, defaultUrl: PET_AVATAR_ART[characterId], pick, clear }
}
