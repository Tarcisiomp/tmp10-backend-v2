// TMP10 — envio de notificações Web Push (um lugar só para todo o backend).
//
// Antes, cada rota tinha o seu próprio laço com webpush.sendNotification() e QUALQUER erro que não fosse
// 404/410 era engolido em silêncio (catch vazio). Erros comuns que faziam a notificação "não chegar" sem
// ninguém saber:
//   · 403 / 401  → a inscrição foi criada com OUTRA chave VAPID (ex.: depois da troca de chaves do passo 0.2)
//                  ou o token VAPID foi recusado (Apple: BadJwtToken). Precisa reinscrever o aparelho.
//   · 400 / 413  → inscrição/payload inválidos.
//   · 404 / 410  → inscrição expirada (o aparelho cancelou) → removida, como antes.
// Agora: cada falha é registrada no log com o provedor e o motivo, e as rotas devolvem o resumo.
// Opções de entrega: urgência alta (Apple e Android entregam na hora, mesmo com o aparelho em repouso)
// e validade de 24 h (se o aparelho estiver desligado, recebe quando ligar, até 24 h).
const TTL_PADRAO = 24 * 60 * 60
const URGENCIA = 'high'

// Destinos que o ERP sabe abrir quando a pessoa toca na notificação (?abrir=<destino>)
const DESTINOS = { 'nova-venda': 'pedidos-externos', 'aviso-equipe': 'avisos', 'conta-vencendo': 'financeiro', teste: 'inicio' }

function provedorDe(endpoint) {
  let host = ''
  try { host = new URL(endpoint).hostname } catch (e) { return 'invalido' }
  if (host.endsWith('push.apple.com')) return 'apple'
  if (host.endsWith('googleapis.com')) return 'chrome'
  if (host.endsWith('mozilla.com') || host.endsWith('mozaws.net')) return 'firefox'
  if (host.endsWith('notify.windows.com')) return 'edge-windows'
  return 'outro'
}

function motivoDoErro(status, corpo) {
  const t = String(corpo || '')
  if (status === 404 || status === 410) return 'inscrição expirada ou cancelada no aparelho (removida)'
  if (status === 403 || status === 401) {
    if (/VAPID|credential|BadJwtToken|InvalidProviderToken|BadWebPushTopic/i.test(t)) return 'chave VAPID diferente da usada na inscrição — o aparelho precisa reativar as notificações'
    return 'recusado pelo serviço de push (chave/permissão) — o aparelho precisa reativar as notificações'
  }
  if (status === 413) return 'mensagem grande demais'
  if (status === 400) return 'inscrição ou mensagem inválida'
  if (status === 429) return 'muitas notificações em pouco tempo (limite do serviço de push)'
  if (status >= 500) return 'serviço de push indisponível no momento'
  return 'falha de rede ao falar com o serviço de push'
}

function montarPayload({ title, body, tag, destino }) {
  const t = tag || 'tmp10-notificacao'
  const d = destino || DESTINOS[t] || 'inicio'
  return JSON.stringify({
    title: String(title || '🔔 TMP10').slice(0, 120),
    body: String(body || '').slice(0, 500),
    tag: t,
    destino: d,
    url: '/?abrir=' + encodeURIComponent(d),
    ts: Date.now()
  })
}

function criarEnvioPush({ sb, webpush, log = console.log, ttl = TTL_PADRAO, opcoesExtras = {} }) {
  async function enviarParaInscricoes(inscricoes, mensagem) {
    const payload = montarPayload(mensagem)
    const resultado = { enviados: 0, falhas: 0, removidas: 0, detalhes: [] }
    for (const s of inscricoes || []) {
      const provedor = provedorDe(s.endpoint)
      if (!s.endpoint || !s.p256dh || !s.auth) {
        resultado.falhas++
        resultado.detalhes.push({ provedor, ok: false, status: null, motivo: 'inscrição incompleta (sem chaves) — reativar no aparelho' })
        log(`[PUSH] inscrição ${s.id || '?'} (${provedor}) incompleta — ignorada`)
        continue
      }
      try {
        const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: ttl, urgency: URGENCIA, ...opcoesExtras })
        resultado.enviados++
        resultado.detalhes.push({ provedor, ok: true, status: (r && r.statusCode) || 201 })
      } catch (err) {
        const status = err && err.statusCode ? err.statusCode : null
        const motivo = motivoDoErro(status, err && err.body)
        resultado.falhas++
        resultado.detalhes.push({ provedor, ok: false, status, motivo })
        // o endpoint é um endereço secreto do aparelho: no log vai só o id da inscrição e o provedor
        log(`[PUSH] falha ao enviar para a inscrição ${s.id || '?'} (${provedor}, usuário ${s.user_id || '?'}): ${status || 'sem status'} — ${motivo}${err && err.body ? ' — ' + String(err.body).slice(0, 200) : ''}`)
        if (status === 404 || status === 410) {
          const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
          if (!error) resultado.removidas++
        }
      }
    }
    return resultado
  }

  // Inscrições de uma empresa (opcional: só alguns usuários / menos um usuário)
  async function enviarParaEmpresa(empresaId, mensagem, { userIds, excluirUserId } = {}) {
    let q = sb.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').eq('empresa_id', empresaId)
    if (Array.isArray(userIds) && userIds.length) q = q.in('user_id', userIds)
    const { data, error } = await q
    if (error) throw error
    const alvo = (data || []).filter((s) => !excluirUserId || s.user_id !== excluirUserId)
    const r = await enviarParaInscricoes(alvo, mensagem)
    r.inscricoes = alvo.length
    r.ignoradas_remetente = (data || []).length - alvo.length
    log(`[PUSH] empresa ${empresaId} (${mensagem.tag || '-'}): ${alvo.length} inscrição(ões), ${r.enviados} enviada(s), ${r.falhas} falha(s)${r.ignoradas_remetente ? `, ${r.ignoradas_remetente} do próprio remetente (não recebe o aviso da própria venda)` : ''}`)
    return r
  }

  return { enviarParaInscricoes, enviarParaEmpresa }
}

// Confere se VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY (Railway) são um PAR. Se não forem, TODO push é recusado (403)
// por Apple e Google — e antes ninguém ficava sabendo. Devolve { ok, motivo }.
function conferirParVapid(publica, privada) {
  try {
    const crypto = require('crypto')
    const ecdh = crypto.createECDH('prime256v1')
    const bytes = Buffer.from(String(privada || ''), 'base64url')
    if (bytes.length !== 32) throw new Error('precisa ter 32 bytes (base64url)')
    ecdh.setPrivateKey(bytes)
    const derivada = ecdh.getPublicKey().toString('base64url')
    return derivada === String(publica || '').trim().replace(/=+$/, '')
      ? { ok: true }
      : { ok: false, motivo: 'VAPID_PUBLIC_KEY não corresponde à VAPID_PRIVATE_KEY (gere o par de novo e atualize as duas no Railway)' }
  } catch (e) {
    return { ok: false, motivo: 'VAPID_PRIVATE_KEY inválida: ' + e.message }
  }
}

module.exports = { conferirParVapid, criarEnvioPush, montarPayload, provedorDe, motivoDoErro, DESTINOS, TTL_PADRAO }
