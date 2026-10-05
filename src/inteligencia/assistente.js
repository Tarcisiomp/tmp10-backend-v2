// ETAPAS 20 e 21 — Assistente (texto ou voz) e ações com aprovação.
// A voz vira texto no navegador (reconhecimento de fala do próprio aparelho) e chega aqui como pergunta.
// O assistente NÃO tem lógica financeira própria: chama os mesmos serviços do ERP (servico.calcularDRE, alertas, produtos).
// Ação sensível (emitir nota, mudar preço...) nunca é executada direto: devolve "requer confirmação" e só roda
// em /acoes/executar, por um administrador, e só se existir um executor real cadastrado para ela.
const dados = require('./dados')
const { brl, pct, ND } = require('./agentes')

const sem = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
function periodoDaFrase(t) {
  if (/\bontem\b/.test(t)) return { periodo: 'ontem', rotulo: 'ontem' }
  if (/\bsemana\b|7 dias/.test(t)) return { periodo: 'semana', rotulo: 'nos últimos 7 dias' }
  if (/\bano\b/.test(t)) return { periodo: 'ano', rotulo: 'neste ano' }
  if (/\bmes\b/.test(t)) return { periodo: 'mes', rotulo: 'neste mês' }
  return { periodo: 'hoje', rotulo: 'hoje' }
}

// Ações que exigem confirmação. "executor: null" = ainda não existe integração real → nunca finge que fez.
const ACOES = {
  emitir_nota: { rotulo: 'Emitir nota fiscal', pergunta: 'Confirma emissão da nota?', executor: null, falta: 'É necessário configurar o provedor fiscal (ver documentação da fase fiscal).' },
  alterar_preco: { rotulo: 'Alterar preço de anúncio', pergunta: 'Confirma a alteração de preço?', executor: null, falta: 'A alteração de preço no marketplace ainda não está habilitada no TMP10.' },
  alterar_anuncio: { rotulo: 'Alterar anúncio', pergunta: 'Confirma a alteração do anúncio?', executor: null, falta: 'A edição de anúncios no marketplace ainda não está habilitada no TMP10.' }
}

function criarAssistente({ sb, servico }) {
  async function perguntar(empresaId, usuario, pergunta) {
    const t = sem(pergunta).trim()
    if (!t) return { resposta: 'Não entendi a pergunta.', entendido: false }
    // 1) ações sensíveis → só com confirmação
    if (/\b(emit|emitir|emita|gere a nota|gerar nota)\b.*\bnota\b|\bnota\b.*\b(emit|emitir|emita)/.test(t)) return pedirConfirmacao('emitir_nota')
    if (/\b(mude|mudar|altere|alterar|aumente|abaixe|baixe)\b.*\bpreco\b/.test(t)) return pedirConfirmacao('alterar_preco')
    if (/\b(mude|mudar|altere|alterar|troque|trocar)\b.*\b(titulo|anuncio|foto|descricao)\b/.test(t)) return pedirConfirmacao('alterar_anuncio')

    const per = periodoDaFrase(t)
    // 2) prejuízo
    if (/prejuizo/.test(t)) {
      const r = await servico.calcularDRE(empresaId, { periodo: per.periodo === 'hoje' && !/hoje/.test(t) ? 'semana' : per.periodo, agrupar: 'produto' })
      const ruins = r.grupos.filter((g) => g.lucro < 0).sort((a, b) => a.lucro - b.lucro)
      const rot = per.periodo === 'hoje' && !/hoje/.test(t) ? 'nos últimos 7 dias' : per.rotulo
      if (!ruins.length) return { resposta: `Nenhum produto deu prejuízo ${rot}.`, entendido: true, intencao: 'prejuizo', dados: [] }
      return { resposta: `${ruins.length} produto(s) com prejuízo ${rot}. O pior: ${ruins[0].rotulo}, prejuízo de ${brl(-ruins[0].lucro)} em ${ruins[0].pedidos} venda(s).`, entendido: true, intencao: 'prejuizo', dados: ruins.slice(0, 10) }
    }
    // 3) lucro
    if (/lucro/.test(t)) {
      const r = await servico.calcularDRE(empresaId, { periodo: per.periodo })
      const s = r.resumo
      return { resposta: `Lucro ${per.rotulo}: ${brl(s.lucro)} (margem ${pct(s.margem)}) sobre faturamento de ${brl(s.faturamento)} em ${s.pedidos} venda(s).` + (s.vendas_com_pendencia ? ` Atenção: ${s.vendas_com_pendencia} venda(s) com custo pendente.` : '') + ' Publicidade não incluída (dado não disponível).', entendido: true, intencao: 'lucro', dados: s }
    }
    // 4) mais vendido
    if (/mais vendido|vendendo mais|vende mais|campeao/.test(t)) {
      const r = await servico.calcularDRE(empresaId, { periodo: /hoje|ontem|semana|ano/.test(t) ? per.periodo : 'mes', agrupar: 'produto' })
      const top = r.grupos.slice().sort((a, b) => b.quantidade - a.quantidade)
      if (!top.length) return { resposta: 'Não há vendas no período.', entendido: true, intencao: 'mais_vendido', dados: [] }
      return { resposta: `O mais vendido ${/hoje|ontem|semana|ano/.test(t) ? per.rotulo : 'neste mês'} é ${top[0].rotulo}: ${top[0].quantidade} unidade(s), ${brl(top[0].faturamento)}.`, entendido: true, intencao: 'mais_vendido', dados: top.slice(0, 10) }
    }
    // 5) mostrar vendas
    if (/mostr|lista|quais (foram )?as vendas/.test(t) && /venda/.test(t)) {
      const r = await servico.calcularDRE(empresaId, { periodo: per.periodo, agrupar: 'pedido' })
      return { resposta: `${r.resumo.pedidos} venda(s) ${per.rotulo}, total ${brl(r.resumo.faturamento)}.`, entendido: true, intencao: 'listar_vendas', dados: r.grupos.slice(0, 50) }
    }
    // 6) quanto vendi / faturamento
    if (/vend|fatur/.test(t)) {
      const r = await servico.calcularDRE(empresaId, { periodo: per.periodo })
      const s = r.resumo
      return { resposta: `Você vendeu ${brl(s.faturamento)} ${per.rotulo}, em ${s.pedidos} venda(s) e ${s.produtos_vendidos} produto(s).`, entendido: true, intencao: 'vendas', dados: s }
    }
    // 7) anúncio parado
    if (/anuncio/.test(t) && /parad|sem venda/.test(t)) {
      const lista = await servico.alertas.listar(empresaId, { status: 'abertos' })
      const parados = lista.filter((a) => a.tipo === 'anuncio_parado')
      return { resposta: parados.length ? `Sim: ${parados.length} anúncio(s) sem venda pela regra configurada. Exemplo: ${parados[0].titulo.replace(/^🟠\s*/, '')}.` : 'Nenhum anúncio parado nos alertas abertos. (A lista é atualizada quando a Central roda os agentes.)', entendido: true, intencao: 'anuncios_parados', dados: parados.slice(0, 20).map((a) => a.dados) }
    }
    // 8) estoque
    if (/estoque/.test(t)) {
      const produtos = await dados.produtos(sb, empresaId)
      const ativos = produtos.filter((p) => p.active !== false)
      const palavras = t.replace(/\b(qual|quanto|quantos|tem|meu|minha|o|a|de|do|da|no|na|estoque|e|em)\b/g, ' ').split(/\s+/).filter((w) => w.length >= 3)
      if (palavras.length) {
        const achados = ativos.filter((p) => palavras.every((w) => sem(p.name + ' ' + p.sku).includes(w)))
        if (achados.length) return { resposta: achados.slice(0, 3).map((p) => `${p.name}: ${p.estoque_atual ?? ND.toLowerCase()} unidade(s)`).join('. ') + '.', entendido: true, intencao: 'estoque_produto', dados: achados.slice(0, 20).map((p) => ({ sku: p.sku, nome: p.name, estoque: p.estoque_atual })) }
      }
      const zerados = ativos.filter((p) => p.estoque_atual !== null && Number(p.estoque_atual) <= 0)
      const baixos = ativos.filter((p) => { const lim = p.estoque_alerta ?? p.estoque_minimo; return lim !== null && p.estoque_atual !== null && Number(p.estoque_atual) > 0 && Number(p.estoque_atual) <= Number(lim) })
      const total = ativos.reduce((s, p) => s + (Number(p.estoque_atual) || 0), 0)
      return { resposta: `Você tem ${ativos.length} produto(s) ativos, ${total} unidade(s) no total. ${zerados.length} zerado(s) e ${baixos.length} com estoque baixo.`, entendido: true, intencao: 'estoque', dados: { produtos: ativos.length, unidades: total, zerados: zerados.map((p) => p.name).slice(0, 20), baixos: baixos.map((p) => p.name).slice(0, 20) } }
    }
    return { resposta: 'Ainda não sei responder isso. Tente: "Quanto vendi hoje?", "Qual meu lucro no mês?", "Qual produto está dando prejuízo?", "Tem anúncio parado?", "Qual meu estoque?", "Qual produto está vendendo mais?".', entendido: false }
  }

  function pedirConfirmacao(acao) {
    const a = ACOES[acao]
    return { resposta: a.pergunta, entendido: true, intencao: acao, requer_confirmacao: true, acao: { tipo: acao, rotulo: a.rotulo, disponivel: !!a.executor, aviso: a.executor ? null : a.falta } }
  }

  // Executa uma ação JÁ confirmada pela pessoa. Exige administrador (rotas.js) e um executor real.
  async function executar(empresaId, usuario, corpo = {}) {
    const a = ACOES[corpo.acao]
    if (!a) throw Object.assign(new Error('Ação desconhecida.'), { status: 400 })
    if (corpo.confirmado !== true) throw Object.assign(new Error('Esta ação precisa de confirmação.'), { status: 400 })
    if (!a.executor) throw Object.assign(new Error(a.falta), { status: 501 })
    return a.executor({ sb, empresaId, usuario, parametros: corpo.parametros || {} })
  }

  return { perguntar, executar }
}

module.exports = { criarAssistente, ACOES }
