// Estoque Central — REVISÃO MANUAL AUDITADA (negativos, números de preenchimento, produtos importados pendentes de contagem)
// e DEVOLUÇÃO RECEBIDA (entrada manual). Nada aqui é automático: toda escrita exige confirmação explícita do operador
// ("conferido") e passa pela função oficial estoque_movimentar (movimento com usuário, motivo, referência idempotente e
// "estoque esperado" — se o número mudou enquanto a pessoa contava, a revisão é recusada).
//
// DEVOLUÇÃO: o TMP10 NÃO trata devolução como cancelamento e NÃO dá entrada sozinho. A doc do Mercado Livre ("Gerenciar
// devoluções") mostra que a devolução é um fluxo de reclamação (claims/returns) com estados próprios (opened, shipped,
// delivered…) e revisão do vendedor; a da Shopee também é separada do cancelamento. Sem integração validada com esses
// fluxos, a entrada só acontece quando o operador registra que RECEBEU a peça — e só para venda que baixou estoque pelo
// fluxo oficial, não Full/FBS, não cancelada e no máximo a quantidade vendida (uma vez por pedido+SKU).
const crypto = require('crypto')
const erroHttp = (msg, status) => Object.assign(new Error(msg), { status })
const inteiro = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)))
const ROT = { mercadolivre: 'Mercado Livre', shopee: 'Shopee' }
const LIMITE_PREENCHIMENTO = 999

function criarRevisao({ sb, q, grupos, movimentar, log = console.log }) {
  // Produtos que precisam de revisão: negativo · 999 ou mais · sem estoque oficial (inclui importados pendentes de contagem)
  async function pendentes({ empresaId, limite = 300 }) {
    const lerTodos = async (montar) => { const t = []; for (let de = 0; ; de += 1000) { const l = await q(montar().range(de, de + 999), 'produtos'); t.push(...(l || [])); if (!l || l.length < 1000) return t } }
    const neg = await lerTodos(() => sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).lt('estoque_atual', 0).order('estoque_atual'))
    const alto = await lerTodos(() => sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).gte('estoque_atual', LIMITE_PREENCHIMENTO).order('estoque_atual', { ascending: false }))
    const nulos = await lerTodos(() => sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).is('estoque_atual', null))
    const marcados = new Set(((await q(sb.from('estoque_movimentos').select('sku').eq('empresa_id', empresaId).eq('origem', 'importacao_pendente_contagem').limit(5000), 'importados pendentes')) || []).map((m) => m.sku))
    const g = await grupos.carregar(empresaId)
    const item = (p, motivo) => ({ sku: p.sku, nome: p.name, estoque_normal: p.estoque_atual, motivo, agrupado_em: g.principalDe(p.sku) })
    const lista = [...neg.map((p) => item(p, 'negativo')), ...alto.map((p) => item(p, 'preenchimento')),
      ...nulos.map((p) => item(p, marcados.has(p.sku) ? 'importado_pendente_contagem' : 'sem_estoque_oficial'))]
    return { total: lista.length, itens: lista.slice(0, Math.min(Number(limite) || 300, 1000)),
      contagem: { negativo: neg.length, preenchimento: alto.length, importado_pendente_contagem: nulos.filter((p) => marcados.has(p.sku)).length, sem_estoque_oficial: nulos.filter((p) => !marcados.has(p.sku)).length } }
  }

  // Revisão por CONTAGEM FÍSICA: "fica com N", só se o estoque ainda for o que a pessoa viu (esperado), com motivo e "conferido"
  async function revisarSaldo({ empresaId, sku, contagem, estoqueEsperado, motivo, conferido, usuarioId, idOperacao }) {
    if (conferido !== true) throw erroHttp('Marque "Contei fisicamente esta peça" antes de confirmar a revisão.', 400)
    const n = inteiro(contagem)
    if (n === null || n < 0 || n > 1000000) throw erroHttp('Informe a quantidade contada (0 a 1.000.000).', 400)
    const mot = String(motivo || '').trim()
    if (mot.length < 5) throw erroHttp('Descreva o motivo da revisão (ex.: "contagem física 30/10").', 400)
    const s = String(sku || '').trim(); if (!s || s.length > 120) throw erroHttp('SKU inválido.', 400)
    const principal = (await grupos.carregar(empresaId)).principalDe(s)
    if (principal) throw erroHttp(`O SKU ${s} está agrupado em ${principal}: o estoque oficial é o do principal. Revise o ${principal}.`, 409)
    const atual = await q(sb.from('products').select('estoque_atual').eq('empresa_id', empresaId).eq('sku', s), 'produto')
    if (!atual || !atual.length) throw erroHttp('Produto não encontrado nesta empresa.', 404)
    if (atual.length > 1) throw erroHttp('Há mais de um produto com este SKU. Corrija o cadastro antes.', 409)
    // "esperado": o número que a pessoa viu na tela. Produto sem estoque oficial (nulo) é comparado como 0 pela função oficial.
    const viu = estoqueEsperado === null || estoqueEsperado === undefined || estoqueEsperado === '' ? null : inteiro(estoqueEsperado)
    if ((atual[0].estoque_atual ?? null) !== viu) throw Object.assign(erroHttp(`O estoque deste produto agora é ${atual[0].estoque_atual ?? 'sem estoque oficial'} (a tela mostrava ${viu ?? 'sem estoque oficial'}). Confira e revise de novo.`, 409), { atual: atual[0].estoque_atual })
    const op = /^[A-Za-z0-9_-]{8,64}$/.test(String(idOperacao || '')) ? String(idOperacao) : crypto.randomUUID()
    const r = await movimentar({ empresaId, sku: s, tipo: 'definir', quantidade: n, origem: 'revisao_contagem',
      motivo: `Revisão por contagem física: ${mot}`.slice(0, 300), referencia: `revisao:${op}`, usuarioId, processo: 'erp', esperado: viu === null ? 0 : viu })
    if (r && r.erro === 'estoque_mudou') throw Object.assign(erroHttp(`O estoque mudou para ${r.anterior} enquanto você contava. Confira e revise de novo.`, 409), { atual: r.anterior })
    if (r && !r.aplicado && !r.duplicado) throw erroHttp(`Revisão não aplicada: ${r.erro || 'erro'}`, 409)
    log(`📝 [ESTOQUE] revisão por contagem — ${s}: ${viu ?? 'sem estoque'} → ${n} (usuário ${usuarioId || '-'}; ${mot.slice(0, 80)})`)
    return { ok: true, sku: s, anterior: viu, novo: n, duplicado: !!(r && r.duplicado), movimento_id: r && r.movimento_id }
  }

  // DEVOLUÇÃO RECEBIDA (manual, auditada): entrada no produto que a venda REALMENTE baixou
  async function registrarDevolucao({ empresaId, plataforma, pedidoId, sku, quantidade, recebido, motivo, usuarioId }) {
    if (recebido !== true) throw erroHttp('Marque "Recebi a peça fisicamente e ela volta para venda" antes de registrar.', 400)
    if (!['mercadolivre', 'shopee'].includes(plataforma)) throw erroHttp('Plataforma inválida.', 400)
    const ped = String(pedidoId || '').trim(); const s = String(sku || '').trim()
    if (!ped || !s) throw erroHttp('Informe o pedido e o SKU.', 400)
    const qtd = inteiro(quantidade); if (qtd === null || qtd < 1) throw erroHttp('Informe a quantidade recebida (1 ou mais).', 400)
    const pedido = await q(sb.from('ml_orders').select('ml_order_id, platform, is_fulfillment, status, items').eq('empresa_id', empresaId).eq('ml_order_id', ped).maybeSingle(), 'pedido')
    if (!pedido) throw erroHttp(`Pedido ${ped} não encontrado no TMP10 desta empresa.`, 404)
    if ((pedido.platform || 'mercadolivre') !== plataforma) throw erroHttp(`O pedido ${ped} é de outra plataforma.`, 409)
    if (pedido.is_fulfillment) throw erroHttp(`O pedido ${ped} é Full/FBS: a devolução volta para o armazém da plataforma, não para o seu estoque. Nada registrado.`, 409)
    const venda = await q(sb.from('estoque_movimentos').select('sku, quantidade, aplicado').eq('empresa_id', empresaId).eq('referencia', `venda:${plataforma}:${ped}:${s}`).maybeSingle(), 'venda')
    if (!venda || !venda.aplicado || !(venda.quantidade < 0)) throw erroHttp(`A venda do SKU ${s} no pedido ${ped} não baixou o estoque pelo fluxo oficial — não há o que devolver automaticamente. Se a peça voltou, use a revisão por contagem.`, 409)
    const canc = await q(sb.from('estoque_movimentos').select('id, aplicado').eq('empresa_id', empresaId).eq('referencia', `cancelamento:${plataforma}:${ped}:${s}`).maybeSingle(), 'cancelamento')
    if (canc && canc.aplicado) throw erroHttp(`O pedido ${ped} já foi cancelado e o estoque já voltou pelo cancelamento. Nada registrado.`, 409)
    if (qtd > -venda.quantidade) throw erroHttp(`A venda baixou ${-venda.quantidade} unidade(s); não dá para devolver ${qtd}.`, 400)
    const mot = String(motivo || '').trim()
    const r = await movimentar({ empresaId, sku: venda.sku || s, tipo: 'entrada', quantidade: qtd, origem: `devolucao_${plataforma}`,
      motivo: `Devolução RECEBIDA ${ROT[plataforma]} ${ped} (${qtd} un. de ${-venda.quantidade})${mot ? ' — ' + mot : ''}`.slice(0, 300),
      referencia: `devolucao:${plataforma}:${ped}:${s}`, usuarioId, processo: 'erp' })
    if (r && r.duplicado) throw erroHttp(`A devolução do SKU ${s} no pedido ${ped} já foi registrada (${r.anterior} → ${r.novo}). Nada mudou.`, 409)
    if (r && !r.aplicado) throw erroHttp(`Devolução não aplicada: ${r.erro || 'erro'}`, 409)
    log(`↩️ [ESTOQUE] devolução recebida (manual) — ${ROT[plataforma]} ${ped}, ${s}: +${qtd} em ${venda.sku || s} (usuário ${usuarioId || '-'})`)
    return { ok: true, sku: venda.sku || s, ...(venda.sku && venda.sku !== s ? { principal: venda.sku } : {}), anterior: r.anterior, novo: r.novo, movimento_id: r.movimento_id }
  }

  return { pendentes, revisarSaldo, registrarDevolucao }
}

module.exports = { criarRevisao, LIMITE_PREENCHIMENTO }
