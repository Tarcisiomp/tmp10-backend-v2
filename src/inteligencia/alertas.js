// Central de alertas: grava sem duplicar, resolve sozinho o que normalizou e avisa por push os CRÍTICOS novos.
// Tabela public.alertas (migração 20) — só o backend acessa. Toda operação tem .eq('empresa_id', empresaId).

// Tipos de "situação" (enquanto a condição existir o alerta fica aberto; quando some dos dados, é resolvido sozinho).
// Os demais (ex.: prejuízo de uma venda) são fatos: só a pessoa resolve.
const TIPOS_SITUACAO = ['estoque_zerado', 'estoque_baixo', 'risco_ruptura', 'estoque_excesso', 'vendendo_rapido', 'anuncio_parado', 'conta_atrasada', 'conta_vence_hoje', 'receber_atrasado', 'caixa_negativo',
  'margem_negativa', 'margem_baixa', 'margem_boa', 'queda_vendas', 'alta_vendas']
const UM_DIA_MS = 24 * 60 * 60 * 1000
const RESOLUCAO_AUTO = 'Normalizado automaticamente: a condição não aparece mais nos dados.'
const MAX_NOVOS_POR_TIPO = 100
const NIVEIS = ['critico', 'atencao', 'oportunidade']

function tabelaAusente(error) {
  const t = `${error && error.code} ${error && error.message}`
  return /42P01|PGRST205|does not exist|Could not find the table/i.test(t)
}
function erroBanco(error) {
  if (tabelaAusente(error)) return Object.assign(new Error('Central de Inteligência não instalada: aplique a migração docs/sql/20-inteligencia.sql no Supabase.'), { status: 503 })
  return new Error(error.message || 'erro no banco')
}

function criarAlertas({ sb, envioPush = null, log = console.log }) {
  async function abertosEUltimos(empresaId, chaves) {
    const existentes = []
    for (let i = 0; i < chaves.length; i += 150) {
      const { data, error } = await sb.from('alertas').select('id, chave, tipo, resolvido, resolvido_por, resolucao, ocorrencias, dados, push_enviado_em').eq('empresa_id', empresaId).in('chave', chaves.slice(i, i + 150))
      if (error) throw erroBanco(error)
      existentes.push(...(data || []))
    }
    return existentes
  }
  // lista paginada (o Supabase devolve no máximo 1000 por vez) com ordem única (id)
  async function paginado(montar) {
    const linhas = []
    for (let de = 0; de < 100000; de += 1000) {
      const { data, error } = await montar().order('id', { ascending: true }).range(de, de + 999)
      if (error) throw erroBanco(error)
      linhas.push(...(data || []))
      if (!data || data.length < 1000) break
    }
    return linhas
  }

  // candidatos: [{ tipo, nivel, prioridade, titulo, mensagem, entidade, entidade_id, dados, chave }]
  // resolverChaves: fatos que deixaram de valer (ex.: venda que não está mais no prejuízo depois da taxa corrigida)
  async function registrar(empresaId, candidatos, { pushCriticos = true, resolverChaves = [] } = {}) {
    const agora = new Date().toISOString()
    const porChave = new Map()
    for (const c of candidatos) if (c && c.chave && NIVEIS.includes(c.nivel)) porChave.set(c.chave, c) // dentro da mesma rodada também não duplica
    const lista = [...porChave.values()]
    const existentes = await abertosEUltimos(empresaId, lista.map((c) => c.chave))
    const mapa = new Map(existentes.map((e) => [e.chave, e]))
    const novos = [], reabertos = [], porTipo = {}
    let atualizados = 0
    for (const c of lista) {
      const e = mapa.get(c.chave)
      if (!e) {
        porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1
        if (porTipo[c.tipo] > MAX_NOVOS_POR_TIPO) continue
        novos.push({ empresa_id: empresaId, tipo: c.tipo, nivel: c.nivel, prioridade: c.prioridade, titulo: c.titulo, mensagem: c.mensagem, entidade: c.entidade || null, entidade_id: c.entidade_id || null, dados: c.dados || {}, chave: c.chave, criado_em: agora, atualizado_em: agora, ocorrencias: 1, lido: false, resolvido: false })
        continue
      }
      if (e.resolvido) {
        // Reabre quando a situação VOLTOU: foi resolvida sozinha, ou a pessoa resolveu e depois a condição chegou a sumir dos dados.
        // Enquanto a condição continua igual, o que a pessoa resolveu fica resolvido (não insiste).
        const encerrada = (!e.resolvido_por && e.resolucao === RESOLUCAO_AUTO) || (e.dados && e.dados._encerrada === true)
        if (encerrada) {
          const { error } = await sb.from('alertas').update({ resolvido: false, resolvido_em: null, resolvido_por: null, resolucao: null, lido: false, lido_em: null, lido_por: null, nivel: c.nivel, prioridade: c.prioridade, titulo: c.titulo, mensagem: c.mensagem, dados: c.dados || {}, atualizado_em: agora, ocorrencias: (e.ocorrencias || 1) + 1 })
            .eq('empresa_id', empresaId).eq('id', e.id)
          if (error) throw erroBanco(error)
          reabertos.push({ ...c, push_enviado_em: e.push_enviado_em })
        }
        continue
      }
      const { error } = await sb.from('alertas').update({ nivel: c.nivel, prioridade: c.prioridade, titulo: c.titulo, mensagem: c.mensagem, dados: c.dados || {}, atualizado_em: agora })
        .eq('empresa_id', empresaId).eq('id', e.id)
      if (error) throw erroBanco(error)
      atualizados++
    }
    const inseridos = []
    for (const linha of novos) {
      // um por vez: se outra rodada inseriu a mesma chave ao mesmo tempo, o índice único barra (23505) e seguimos
      const { data, error } = await sb.from('alertas').insert(linha).select('id, chave, nivel, titulo, mensagem').maybeSingle()
      if (error) { if (String(error.code) === '23505') continue; throw erroBanco(error) }
      inseridos.push(data || linha)
    }

    // Situações que deixaram de existir → resolvidas sozinhas; as que a pessoa resolveu ficam marcadas como "encerradas"
    // (assim, se a condição voltar no futuro, o alerta reabre)
    let resolvidos = 0
    const situacoes = await paginado(() => sb.from('alertas').select('id, chave, tipo, resolvido, resolvido_por, dados').eq('empresa_id', empresaId).in('tipo', TIPOS_SITUACAO))
    for (const a of situacoes) {
      if (porChave.has(a.chave)) continue
      if (!a.resolvido) {
        const { error } = await sb.from('alertas').update({ resolvido: true, resolvido_em: agora, resolucao: RESOLUCAO_AUTO, atualizado_em: agora }).eq('empresa_id', empresaId).eq('id', a.id)
        if (error) throw erroBanco(error)
        resolvidos++
      } else if (a.resolvido_por && !(a.dados && a.dados._encerrada)) {
        const { error } = await sb.from('alertas').update({ dados: { ...(a.dados || {}), _encerrada: true } }).eq('empresa_id', empresaId).eq('id', a.id)
        if (error) throw erroBanco(error)
      }
    }
    // Fatos que deixaram de valer (só os informados, nunca "tudo que não apareceu")
    const fatos = [...new Set(resolverChaves)].filter((k) => !porChave.has(k))
    for (let i = 0; i < fatos.length; i += 150) {
      const { data, error } = await sb.from('alertas').update({ resolvido: true, resolvido_em: agora, resolucao: RESOLUCAO_AUTO, atualizado_em: agora })
        .eq('empresa_id', empresaId).eq('resolvido', false).in('chave', fatos.slice(i, i + 150)).select('id')
      if (error) throw erroBanco(error)
      resolvidos += (data || []).length
    }

    // Push só para CRÍTICOS novos — ou reabertos que não receberam aviso nas últimas 24 h —, só para administradores
    let push = null
    const recente = (t) => t && (Date.now() - new Date(t).getTime()) < UM_DIA_MS
    const criticos = [...inseridos, ...reabertos.filter((r) => !recente(r.push_enviado_em))].filter((a) => a.nivel === 'critico')
    if (pushCriticos && envioPush && criticos.length) push = await avisarCriticos(empresaId, criticos, agora)
    return { novos: inseridos.length, reabertos: reabertos.length, atualizados, resolvidos_automaticamente: resolvidos, push }
  }

  async function avisarCriticos(empresaId, criticos, agora) {
    try {
      const { data: admins, error } = await sb.from('users').select('id').eq('empresa_id', empresaId).eq('role', 'admin').eq('active', true)
      if (error) throw new Error(error.message)
      const userIds = (admins || []).map((u) => u.id)
      if (!userIds.length) return { enviados: 0, motivo: 'empresa sem administrador ativo' }
      const msg = criticos.length === 1
        ? { title: criticos[0].titulo, body: String(criticos[0].mensagem).slice(0, 300), tag: 'alerta-critico', destino: 'central' }
        : { title: `🚨 ${criticos.length} alertas críticos no TMP10`, body: criticos.slice(0, 3).map((c) => c.titulo).join(' · ').slice(0, 300), tag: 'alerta-critico', destino: 'central' }
      const r = await envioPush.enviarParaEmpresa(empresaId, msg, { userIds })
      const chaves = criticos.map((c) => c.chave)
      await sb.from('alertas').update({ push_enviado_em: agora }).eq('empresa_id', empresaId).in('chave', chaves)
      return { enviados: r.enviados, falhas: r.falhas, inscricoes: r.inscricoes }
    } catch (e) {
      log(`[INTELIGENCIA] push dos alertas críticos falhou (empresa ${empresaId}): ${e.message}`)
      return { enviados: 0, erro: e.message }
    }
  }

  async function listar(empresaId, { status = 'abertos', nivel, limite = 200 } = {}) {
    let q = sb.from('alertas').select('id, tipo, nivel, prioridade, titulo, mensagem, entidade, entidade_id, dados, criado_em, atualizado_em, ocorrencias, lido, lido_em, resolvido, resolvido_em, resolucao, responsavel_user_id').eq('empresa_id', empresaId)
    if (status === 'abertos') q = q.eq('resolvido', false)
    else if (status === 'resolvidos') q = q.eq('resolvido', true)
    if (nivel) { if (!NIVEIS.includes(nivel)) throw Object.assign(new Error('Nível inválido.'), { status: 400 }); q = q.eq('nivel', nivel) }
    const { data, error } = await q.order('prioridade', { ascending: false }).order('criado_em', { ascending: false }).limit(Math.min(500, Number(limite) || 200))
    if (error) throw erroBanco(error)
    return data || []
  }

  async function marcar(empresaId, id, usuarioId, acao, resolucao) {
    const agora = new Date().toISOString()
    const { data: alvo, error: e1 } = await sb.from('alertas').select('id, resolvido').eq('empresa_id', empresaId).eq('id', id).maybeSingle()
    if (e1) throw erroBanco(e1)
    if (!alvo) throw Object.assign(new Error('Alerta não encontrado.'), { status: 404 }) // de outra empresa = não existe
    let upd
    if (acao === 'lido') upd = { lido: true, lido_em: agora, lido_por: usuarioId }
    else if (acao === 'resolver') upd = { resolvido: true, resolvido_em: agora, resolvido_por: usuarioId, resolucao: String(resolucao || 'Resolvido').slice(0, 500), lido: true, lido_em: agora, lido_por: usuarioId }
    else if (acao === 'reabrir') upd = { resolvido: false, resolvido_em: null, resolvido_por: null, resolucao: null }
    else if (acao === 'assumir') upd = { responsavel_user_id: usuarioId }
    else throw Object.assign(new Error('Ação inválida.'), { status: 400 })
    const { error } = await sb.from('alertas').update({ ...upd, atualizado_em: agora }).eq('empresa_id', empresaId).eq('id', id)
    if (error) throw erroBanco(error)
    return true
  }

  return { registrar, listar, marcar }
}

module.exports = { criarAlertas, TIPOS_SITUACAO, RESOLUCAO_AUTO, tabelaAusente, erroBanco, NIVEIS }
