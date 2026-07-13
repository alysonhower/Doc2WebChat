import fs from 'fs'
import path from 'path'
import { popup_copy } from './copy'

describe('popup PT-BR copy', () => {
  it('provides Portuguese bridge and Firefox container labels', () => {
    expect(popup_copy.extension_label).toBe('Extensão do navegador')
    expect(popup_copy.bridge_status_aria).toBe(
      'Status da conexão com o aplicativo'
    )
    expect(popup_copy.ready_title).toBe('Pronta para conexões locais')
    expect(popup_copy.enable_containers).toBe('Ativar contêineres')
    expect(popup_copy.default_context).toBe('Contexto padrão do navegador')
  })

  it('localizes the manifest description and browser action title', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../manifest.json'), 'utf8')
    )
    expect(manifest.description).toBe(
      'Preencha chats compatíveis na Web usando o aplicativo Doc2WebChat no seu computador.'
    )
    expect(manifest.name).toBe('Ponte do navegador Doc2WebChat')
    expect(manifest.action.default_title).toBe('Ponte do navegador Doc2WebChat')
  })

  it('declares the popup document as Brazilian Portuguese', () => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    expect(html).toContain('<html lang="pt-BR">')
  })
})
