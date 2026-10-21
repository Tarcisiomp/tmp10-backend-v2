// Estoque Central — AGRUPAMENTO DE ANÚNCIOS (migração 26): leitura e regras de resolução usadas por TODO o estoque.
//
// O agrupamento é uma camada POR CIMA dos vínculos: um anúncio (plataforma + ID + variação) com o SKU ORIGINAL dele passa
// a pertencer a um PRODUTO PRINCIPAL. Os vínculos, os produtos e os SKUs dos anúncios não mudam.
//   • venda de anúncio agrupado → baixa o PRINCIPAL (referência continua a do SKU original: idempotência inalterada);
//   • venda que não bate com o agrupamento → PENDÊNCIA (não baixa estoque de produto nenhum);
//   • fila do principal → anúncios dele + anúncios agrupados; o SKU original agrupado NUNCA envia o próprio saldo;
//   • sem agrupamento nenhum, tudo funciona exatamente como antes.
// Sem a tabela (migração 26 ainda não aplicada), o backend trata todos os SKUs como NÃO agrupados (comportamento anterior).

const chave = (plataforma, anuncio, variacao) => `${plataforma}|${String(anuncio)}|${variacao ? String(variacao) : ''}`
const tabelaFaltando = (e) => e && (e.code === 'PGRST205' || e.code === '42P01' || /estoque_agrupamento/.test(String(e.message || '')) && /(does not exist|Could not find)/i.test(String(e.message || '')))

function montar(linhas) {
  const porAnuncio = new Map(), porOriginal = new Map(), porPrincipal = new Map(), porItem = new Map()
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v) }
  for (const l of linhas) {
    porAnuncio.set(chave(l.plataforma, l.anuncio_id, l.variacao_id), l)
    add(porItem, `${l.plataforma}|${l.anuncio_id}`, l)
    add(porOriginal, l.sku_original, l)
    add(porPrincipal, l.produto_sku, l)
  }
  const membros = (sku) => porPrincipal.get(sku) || []
  return {
    linhas, vazio: linhas.length === 0,
    doAnuncio: (plataforma, anuncio, variacao = '') => porAnuncio.get(chave(plataforma, anuncio, variacao)) || null,
    // SKU original que foi ABSORVIDO por outro principal → o principal; senão null
    principalDe: (sku) => { const r = porOriginal.get(sku); return r && r.length ? r[0].produto_sku : null },
    membros,
    ehPrincipal: (sku) => membros(sku).length > 0,
    // SKUs que chegam nos pedidos/vínculos e representam este produto (o próprio + os originais agrupados)
    originais: (sku) => new Set([sku, ...membros(sku).map((m) => m.sku_original)]),
    // produto que o anúncio representa hoje (vínculo com SKU original → principal, se agrupado)
    skuEfetivo: (plataforma, anuncio, variacao, skuLink) => { const g = porAnuncio.get(chave(plataforma, anuncio, variacao)); return g ? g.produto_sku : skuLink },
    // Venda: item do pedido { sku, ml_item_id } → { sku } (produto a baixar) ou { pendencia } (não baixa nada)
    resolverVenda(plataforma, item) {
      const sku = item && item.sku ? String(item.sku).trim() : ''
      if (!linhas.length) return { sku }
      const anuncio = item && item.ml_item_id !== undefined && item.ml_item_id !== null && item.ml_item_id !== '' ? String(item.ml_item_id) : ''
      const doItem = anuncio ? (porItem.get(`${plataforma}|${anuncio}`) || []) : []
      if (doItem.length) {
        const m = doItem.filter((l) => l.sku_original === sku)
        if (m.length === 1) return { sku: m[0].produto_sku, agrupado: m[0] }
        // anúncio inteiro agrupado (sem variação): qualquer pedido dele é dele — SKU diferente = o anúncio mudou de SKU
        const inteiro = doItem.find((l) => !l.variacao_id)
        if (inteiro) return { pendencia: `o anúncio ${anuncio} está agrupado em ${inteiro.produto_sku} com o SKU "${inteiro.sku_original}", mas o pedido veio com o SKU "${sku}"` }
      }
      const abs = porOriginal.get(sku)
      if (abs && abs.length) return { pendencia: `o SKU "${sku}" está agrupado em ${abs[0].produto_sku}, mas o pedido veio do anúncio ${anuncio || '(não informado)'}, que não faz parte do agrupamento` }
      return { sku }
    }
  }
}

function criarGrupos({ sb, log = console.log }) {
  let avisou = false
  async function carregar(empresaId) {
    const linhas = []
    for (let de = 0; ; de += 1000) {
      const r = await sb.from('estoque_agrupamento').select('id, produto_sku, plataforma, conta_ref, conta_nome, anuncio_id, variacao_id, sku_original, operacao_id, criado_por, criado_em')
        .eq('empresa_id', empresaId).eq('ativo', true).order('id', { ascending: true }).range(de, de + 999)
      if (r.error) {
        if (tabelaFaltando(r.error)) {
          if (!avisou) { avisou = true; log('[ESTOQUE] migração 26 (agrupamento) ainda não aplicada — nenhum SKU agrupado') }
          return montar([])
        }
        throw new Error(`agrupamentos: ${r.error.message || r.error}`)
      }
      linhas.push(...(r.data || []))
      if (!r.data || r.data.length < 1000) break
    }
    return montar(linhas)
  }
  return { carregar }
}

module.exports = { criarGrupos, montarGrupos: montar, chaveAnuncio: chave }
