// TMP10 — Super Admin: situação da assinatura de cada empresa e bloqueio por falta de pagamento.
//
// O BACKEND É A AUTORIDADE. O painel só mostra o que vem daqui.
//
// Regra (datas no horário de Brasília):
//   fatura não paga e vencida há 1..TOLERANCIA dias  → EM TOLERÂNCIA (cliente ainda acessa)
//   fatura não paga e vencida há mais de TOLERANCIA  → bloqueio automático (bloqueio_origem = 'inadimplencia')
//   pagamento confirmado e nada mais vencido além da tolerância → reativa sozinho (só se a origem for 'inadimplencia')
//   bloqueio manual (bloqueio_origem = 'manual')      → só o Super Admin reativa; pagamento NÃO reativa
//   INATIVO ou CANCELADO                              → sem acesso; pagamento NÃO reativa (só o Super Admin)
//
// ACESSO (regra final): ativo, trial, em tolerância (e os demais status) → permitido;
//                       bloqueado (qualquer origem), inativo, cancelado → login suspenso.
// A cobrança NÃO muda com o bloqueio: as faturas continuam sendo geradas (processarFechamentosDoDia no server.js).
// Ficam fora da geração: 'inativo', 'cancelado' e plano 'interno'.
//
// "Bloquear" = status 'bloqueado' + login suspenso no Supabase Auth de todos os usuários ATIVOS da empresa
// (o mesmo mecanismo que o passo 0.4 usa para desativar um funcionário). Nada é apagado.
// Usuários já desativados pela própria empresa (active = false) nunca são liberados por aqui.

const TOLERANCIA_DIAS_PADRAO = 5
const BLOQUEIO_LONGO = '876000h' // ~100 anos (mesmo valor do passo 0.4)
const FATURA_NAO_PAGA = ['em_aberto', 'enviada', 'aguardando_pagamento', 'vencido']
const STATUS_SEM_COBRANCA = ['cancelado', 'inativo'] // nunca entram no bloqueio automático por atraso
const STATUS_SEM_ACESSO = ['bloqueado', 'inativo', 'cancelado'] // login suspenso
const temAcesso = (status) => !STATUS_SEM_ACESSO.includes(status)
const COLUNAS_EMPRESA = 'id, nome_empresa, nome_responsavel, email, whatsapp, status, modulos, documento, plano, trial_inicio, trial_fim, dia_vencimento_fatura, ultimo_fechamento, created_at'
const COLUNAS_BLOQUEIO = 'bloqueio_origem, bloqueado_em'

class MigracaoPendente extends Error {
  constructor() { super('As colunas bloqueio_origem/bloqueado_em ainda não existem: rode o sql/09-superadmin-bloqueio.sql no Supabase.'); this.codigo = 'MIGRACAO_09_PENDENTE' }
}
const colunaInexistente = (e) => !!e && (e.code === '42703' || /bloqueio_origem|bloqueado_em/.test(String(e.message || '')))

function lerTolerancia(valor) {
  const n = Number(valor)
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : TOLERANCIA_DIAS_PADRAO
}

// Data de hoje em Brasília, AAAA-MM-DD
function hojeSP(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora)
}
const paraData = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z')
const somarDias = (s, n) => { const d = paraData(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
function diasEntre(de, ate) { return Math.round((paraData(ate) - paraData(de)) / 86400000) }
const dinheiro = (v) => Math.round((Number(v) || 0) * 100) / 100

// Próximo fechamento/vencimento — mesmas regras de processarFechamentosDoDia() no server.js
function proximoVencimento(emp, hoje) {
  if (!emp || emp.plano === 'interno' || STATUS_SEM_COBRANCA.includes(emp.status)) return null
  const dia = Number(emp.dia_vencimento_fatura)
  if (Number.isInteger(dia) && dia >= 1 && dia <= 31) {
    let d = emp.ultimo_fechamento === hoje ? somarDias(hoje, 1) : hoje
    for (let i = 0; i < 400; i++, d = somarDias(d, 1)) if (paraData(d).getUTCDate() === dia) return d
    return null
  }
  if (emp.trial_fim) {
    const primeiro = somarDias(emp.trial_fim, 30)
    return primeiro >= hoje ? primeiro : hoje // já passou: fecha na próxima rodada diária
  }
  return null
}

// Situação calculada de UMA empresa a partir das faturas reais
function calcularSituacao(emp, faturas, { hoje, tolerancia }) {
  const lista = (faturas || []).filter((f) => f.empresa_id === emp.id)
  const naoPagas = lista.filter((f) => FATURA_NAO_PAGA.includes(f.status))
  const vencidas = naoPagas.filter((f) => f.vencimento && f.vencimento < hoje)
  const diasAtraso = vencidas.reduce((m, f) => Math.max(m, diasEntre(f.vencimento, hoje)), 0)
  const maisAntiga = vencidas.slice().sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1))[0] || null
  const porVencimento = lista.slice().sort((a, b) => String(b.vencimento || '').localeCompare(String(a.vencimento || '')))
  const pagas = lista.filter((f) => f.status === 'pago' && f.data_pagamento).sort((a, b) => String(b.data_pagamento).localeCompare(String(a.data_pagamento)))
  const ultima = porVencimento[0] || null
  const ultimoPag = pagas[0] || null

  const semCobranca = emp.plano === 'interno' || STATUS_SEM_COBRANCA.includes(emp.status)
  let codigo
  if (emp.status === 'cancelado') codigo = 'cancelado'
  else if (emp.status === 'inativo') codigo = 'inativo'
  else if (emp.status === 'bloqueado') codigo = 'bloqueado'
  else if (emp.plano === 'interno') codigo = 'interno'
  else if (diasAtraso > tolerancia) codigo = 'em_atraso' // passou da tolerância e ainda não foi bloqueada (a verificação diária bloqueia)
  else if (diasAtraso >= 1) codigo = 'em_tolerancia'
  else if (emp.status === 'inadimplente') codigo = 'em_atraso' // valor antigo marcado à mão
  else if (emp.status === 'trial' && (!emp.trial_fim || emp.trial_fim >= hoje)) codigo = 'trial'
  else if (emp.status === 'pendente') codigo = 'pendente'
  else codigo = 'ativo'

  const venc = proximoVencimento(emp, hoje)
  return {
    codigo,
    acessoPermitido: temAcesso(emp.status),
    bloqueioOrigem: emp.status === 'bloqueado' ? (emp.bloqueio_origem || 'manual') : null,
    bloqueadoEm: emp.status === 'bloqueado' ? (emp.bloqueado_em || null) : null,
    toleranciaDias: tolerancia,
    diasAtraso,
    diasToleranciaRestantes: diasAtraso >= 1 && diasAtraso <= tolerancia ? tolerancia - diasAtraso : null,
    qtdVencidas: vencidas.length,
    valorEmAtraso: dinheiro(vencidas.reduce((s, f) => s + Number(f.valor_total || 0), 0)),
    valorEmAberto: dinheiro(naoPagas.reduce((s, f) => s + Number(f.valor_total || 0), 0)),
    faturaVencidaMaisAntiga: maisAntiga ? { id: maisAntiga.id, vencimento: maisAntiga.vencimento, valor: dinheiro(maisAntiga.valor_total) } : null,
    ultimaFatura: ultima ? { id: ultima.id, vencimento: ultima.vencimento, valor: dinheiro(ultima.valor_total), status: ultima.status } : null,
    ultimoPagamento: ultimoPag ? { data: ultimoPag.data_pagamento, valor: dinheiro(ultimoPag.valor_pago ?? ultimoPag.valor_total), forma: ultimoPag.forma_pagamento || null } : null,
    proximoVencimento: venc,
    diasParaProximoVencimento: venc ? diasEntre(hoje, venc) : null,
    trial: {
      inicio: emp.trial_inicio || null,
      fim: emp.trial_fim || null,
      diasRestantes: emp.trial_fim ? diasEntre(hoje, emp.trial_fim) : null,
      encerrado: !!emp.trial_fim && emp.trial_fim < hoje
    },
    // decisão do bloqueio automático (independe do rótulo acima)
    deveBloquear: !semCobranca && emp.status !== 'bloqueado' && diasAtraso > tolerancia,
    podeReativarSozinha: emp.status === 'bloqueado' && emp.bloqueio_origem === 'inadimplencia' && diasAtraso <= tolerancia
  }
}

// Indicadores do painel (tudo a partir das faturas e empresas reais)
function calcularResumo(empresas, faturas, { hoje, tolerancia }) {
  const mes = hoje.slice(0, 7)
  const sit = empresas.map((e) => calcularSituacao(e, faturas, { hoje, tolerancia }))
  const conta = (c) => sit.filter((s) => s.codigo === c).length
  const naoPagas = faturas.filter((f) => FATURA_NAO_PAGA.includes(f.status))
  const vencidas = naoPagas.filter((f) => f.vencimento < hoje)
  const aVencer = naoPagas.filter((f) => f.vencimento >= hoje)
  const pagasNoMes = faturas.filter((f) => f.status === 'pago' && String(f.data_pagamento || '').slice(0, 7) === mes)
  const doMes = faturas.filter((f) => String(f.vencimento || '').slice(0, 7) === mes && f.status !== 'cancelado')
  const soma = (l, campo = 'valor_total') => dinheiro(l.reduce((s, f) => s + Number((campo === 'valor_pago' ? (f.valor_pago ?? f.valor_total) : f[campo]) || 0), 0))
  return {
    hoje, mes, toleranciaDias: tolerancia,
    clientes: {
      total: empresas.length,
      ativos: conta('ativo'),
      trial: conta('trial'),
      emTolerancia: conta('em_tolerancia'),
      emAtraso: conta('em_atraso'),
      bloqueados: conta('bloqueado'),
      bloqueadosInadimplencia: sit.filter((s) => s.codigo === 'bloqueado' && s.bloqueioOrigem === 'inadimplencia').length,
      cancelados: conta('cancelado'),
      inativos: conta('inativo'),
      pendentes: conta('pendente'),
      internos: conta('interno'),
      semAcesso: sit.filter((s) => !s.acessoPermitido).length
    },
    financeiro: {
      totalDoMes: soma(doMes), qtdDoMes: doMes.length,
      recebidoNoMes: soma(pagasNoMes, 'valor_pago'), qtdRecebidasNoMes: pagasNoMes.length,
      aReceber: soma(aVencer), qtdAReceber: aVencer.length,
      emAtraso: soma(vencidas), qtdEmAtraso: vencidas.length,
      totalNaoPago: soma(naoPagas), qtdNaoPagas: naoPagas.length,
      qtdPagas: faturas.filter((f) => f.status === 'pago').length
    }
  }
}

function criarAssinatura({ sb, tolerancia = TOLERANCIA_DIAS_PADRAO, agora = () => new Date(), log = console.log }) {
  const hoje = () => hojeSP(agora())

  async function lerEmpresas(filtroId) {
    let q = sb.from('empresas').select(`${COLUNAS_EMPRESA}, ${COLUNAS_BLOQUEIO}`)
    if (filtroId) q = q.eq('id', filtroId)
    const { data, error } = await q.order('created_at', { ascending: false })
    if (colunaInexistente(error)) throw new MigracaoPendente()
    if (error) throw error
    return data || []
  }
  async function lerFaturas(empresaId) {
    let q = sb.from('faturas').select('*')
    if (empresaId) q = q.eq('empresa_id', empresaId)
    const { data, error } = await q.order('vencimento', { ascending: false })
    if (error) throw error
    return data || []
  }
  // Mesma marcação que a rota de faturas já fazia: não paga + passou do vencimento → 'vencido'
  async function marcarVencidas() {
    const { error } = await sb.from('faturas').update({ status: 'vencido' }).lt('vencimento', hoje()).in('status', ['em_aberto', 'enviada', 'aguardando_pagamento'])
    if (error) throw error
  }

  // Suspende (banir=true) ou libera o login de todos os usuários ATIVOS da empresa
  async function ajustarLogin(empresaId, banir) {
    const { data: usuarios, error } = await sb.from('users').select('id, auth_id, active').eq('empresa_id', empresaId).eq('active', true)
    if (error) throw error
    let ok = 0; let falhas = 0
    for (const u of usuarios || []) {
      if (!u.auth_id) continue // usuário antigo sem conta no Supabase Auth
      try {
        const { error: e } = await sb.auth.admin.updateUserById(u.auth_id, { ban_duration: banir ? BLOQUEIO_LONGO : 'none' })
        if (e) { falhas++; log(`[ASSINATURA] não consegui ${banir ? 'suspender' : 'liberar'} o login do usuário ${u.id}: ${e.message}`) } else ok++
      } catch (e) { falhas++; log(`[ASSINATURA] erro ao ${banir ? 'suspender' : 'liberar'} o login do usuário ${u.id}: ${e.message}`) }
    }
    return { usuarios: ok, falhas }
  }

  async function bloquear(empresaId, origem) {
    const { error } = await sb.from('empresas').update({ status: 'bloqueado', bloqueio_origem: origem, bloqueado_em: agora().toISOString() }).eq('id', empresaId)
    if (colunaInexistente(error)) throw new MigracaoPendente()
    if (error) throw error
    const login = await ajustarLogin(empresaId, true)
    log(`[ASSINATURA] empresa ${empresaId} BLOQUEADA (${origem}) — login suspenso de ${login.usuarios} usuário(s)${login.falhas ? `, ${login.falhas} falha(s)` : ''}`)
    return login
  }

  async function reativar(empresaId, motivo) {
    const { error } = await sb.from('empresas').update({ status: 'ativo', bloqueio_origem: null, bloqueado_em: null }).eq('id', empresaId)
    if (colunaInexistente(error)) throw new MigracaoPendente()
    if (error) throw error
    const login = await ajustarLogin(empresaId, false)
    log(`[ASSINATURA] empresa ${empresaId} REATIVADA (${motivo}) — login liberado de ${login.usuarios} usuário(s)${login.falhas ? `, ${login.falhas} falha(s)` : ''}`)
    return login
  }

  // Troca de status feita pelo Super Admin (formulário): 'bloqueado' = bloqueio manual;
  // entrar em inativo/cancelado suspende o login; sair de bloqueado/inativo/cancelado para um status com acesso libera.
  async function mudarStatus(emp, novo, motivo) {
    if (!emp || novo === emp.status) return { usuarios: 0, falhas: 0 }
    if (novo === 'bloqueado') return bloquear(emp.id, 'manual')
    const upd = emp.status === 'bloqueado' ? { status: novo, bloqueio_origem: null, bloqueado_em: null } : { status: novo }
    const { error } = await sb.from('empresas').update(upd).eq('id', emp.id)
    if (colunaInexistente(error)) throw new MigracaoPendente()
    if (error) throw error
    let login = { usuarios: 0, falhas: 0 }
    if (temAcesso(emp.status) && !temAcesso(novo)) login = await ajustarLogin(emp.id, true)
    if (!temAcesso(emp.status) && temAcesso(novo)) login = await ajustarLogin(emp.id, false)
    log(`[ASSINATURA] empresa ${emp.id}: ${emp.status} → ${novo} (${motivo}) — login ${temAcesso(novo) ? 'permitido' : 'suspenso'}`)
    return login
  }

  // Verificação (diária e depois de cada pagamento). Só age sobre o que a regra manda; nunca apaga nada.
  async function verificar({ empresaId } = {}) {
    const resultado = { bloqueadas: [], reativadas: [], loginsReaplicados: 0 }
    const h = hoje()
    await marcarVencidas()
    const [empresas, faturas] = await Promise.all([lerEmpresas(empresaId), lerFaturas(empresaId)])
    for (const emp of empresas) {
      try {
        const s = calcularSituacao(emp, faturas, { hoje: h, tolerancia })
        if (s.deveBloquear) {
          await bloquear(emp.id, 'inadimplencia'); resultado.bloqueadas.push(emp.id)
        } else if (s.podeReativarSozinha) {
          await reativar(emp.id, 'pagamento em dia'); resultado.reativadas.push(emp.id)
        } else if (!temAcesso(emp.status) && !empresaId) {
          // bloqueado, inativo ou cancelado: reaplica a suspensão do login (pega usuários criados/reativados depois).
          // Não muda nada no banco — só o login no Supabase Auth.
          const l = await ajustarLogin(emp.id, true); resultado.loginsReaplicados += l.usuarios
        }
      } catch (e) {
        if (e instanceof MigracaoPendente) throw e
        log(`[ASSINATURA] erro ao verificar a empresa ${emp.id}: ${e.message}`)
      }
    }
    return resultado
  }

  async function verificarAgendado() {
    try {
      const r = await verificar()
      log(`[ASSINATURA] verificação diária: ${r.bloqueadas.length} bloqueada(s), ${r.reativadas.length} reativada(s)`)
    } catch (e) {
      log(`[ASSINATURA] verificação diária NÃO rodou: ${e.message}`)
    }
  }

  return { hoje, tolerancia, lerEmpresas, lerFaturas, marcarVencidas, bloquear, reativar, mudarStatus, ajustarLogin, verificar, verificarAgendado }
}

module.exports = {
  criarAssinatura, calcularSituacao, calcularResumo, proximoVencimento, hojeSP, diasEntre, lerTolerancia,
  MigracaoPendente, colunaInexistente, temAcesso, STATUS_SEM_ACESSO, TOLERANCIA_DIAS_PADRAO, FATURA_NAO_PAGA, COLUNAS_EMPRESA, COLUNAS_BLOQUEIO
}
