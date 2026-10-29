// Estoque Central — REGRAS ÚNICAS de diagnóstico (usadas pela prévia do agrupamento E pelo diagnóstico completo, para que
// os dois nunca discordem). Cada achado vira { tipo: 'bloqueio' | 'aviso', codigo, motivo, orientacao }.
//
// Divergência (TMP10 × plataforma) aberta: classificada com a leitura AO VIVO do anúncio, sem alterar nada:
//   full           — anúncio Full confirmado pela API: a divergência antiga comparava o Full com o normal → AVISO (use "Ignorar")
//   obsoleta       — o anúncio JÁ mostra o número atual do TMP10 → AVISO ("Conferir de novo" fecha sozinha)
//   reserva        — Shopee com reserva de promoção maior que o TMP10: o envio é recusado pela Shopee → BLOQUEIO
//   preenchimento  — o anúncio mostra 999 ou mais (número de preenchimento, não estoque físico) → BLOQUEIO
//   tmp10_negativo — o estoque normal do TMP10 está negativo → BLOQUEIO (conte e ajuste o produto primeiro)
//   sem_leitura    — não foi possível ler o anúncio agora → BLOQUEIO (sem conferir, não decide)
//   real           — diferença real sem causa conhecida → BLOQUEIO (decida no painel: enviar TMP10 / aceitar / ignorar)
const LIMITE_PREENCHIMENTO = 999

function classificarDivergencia(d, { vivo = null, tmp10Atual = null, fullConfirmado = false } = {}) {
  if (fullConfirmado) return { classe: 'full', bloqueia: false }
  if (!vivo || vivo.erro || vivo.quantidade === null || vivo.quantidade === undefined) return { classe: 'sem_leitura', bloqueia: true, detalhe: vivo && vivo.erro ? vivo.erro : 'anúncio não lido agora' }
  const t = tmp10Atual === null || tmp10Atual === undefined ? null : Number(tmp10Atual)
  if (t !== null && vivo.quantidade === Math.max(0, t)) return { classe: 'obsoleta', bloqueia: false }
  if (t !== null && t < 0) return { classe: 'tmp10_negativo', bloqueia: true }
  if (vivo.reserva > 0 && t !== null && t < vivo.reserva) return { classe: 'reserva', bloqueia: true }
  if (vivo.quantidade >= LIMITE_PREENCHIMENTO) return { classe: 'preenchimento', bloqueia: true }
  return { classe: 'real', bloqueia: true }
}

const CLASSE_DIVERGENCIA = {
  full: { codigo: 'DIVERGENCIA_FULL', titulo: 'Divergência antiga em anúncio Full',
    orientacao: 'Não é divergência do estoque normal (comparava o Full do ML com o TMP10). No painel do Estoque use "Ignorar" (ou "Ignorar divergências Full" no diagnóstico). Não use "Aceitar": copiaria o Full para o normal.' },
  obsoleta: { codigo: 'DIVERGENCIA_OBSOLETA', titulo: 'Divergência já resolvida na plataforma',
    orientacao: 'O anúncio já mostra o número atual do TMP10. Use "Conferir de novo" (só lê): a divergência fecha sozinha.' },
  reserva: { codigo: 'DIVERGENCIA_RESERVA_SHOPEE', titulo: 'Reserva de promoção da Shopee maior que o TMP10',
    orientacao: 'A Shopee recusa estoque menor que a reserva da promoção. Reduza a reserva ou tire a variação da promoção na Central do Vendedor; depois "Tentar 1 vez". O TMP10 não aumenta o número.' },
  preenchimento: { codigo: 'DIVERGENCIA_PREENCHIMENTO', titulo: 'Anúncio com número de preenchimento (999 ou mais)',
    orientacao: 'O anúncio mostra um número que não é estoque físico. Confira a peça e use "Enviar número do TMP10" (só sai de verdade se o SKU estiver autorizado no modo atual) ou corrija o anúncio na plataforma. Nunca "Aceitar".' },
  tmp10_negativo: { codigo: 'DIVERGENCIA_TMP10_NEGATIVO', titulo: 'Estoque normal do TMP10 negativo',
    orientacao: 'O TMP10 baixou mais vendas do que havia registrado. Conte a peça e faça o ajuste manual do produto (fica no histórico); depois "Conferir de novo".' },
  sem_leitura: { codigo: 'DIVERGENCIA_SEM_LEITURA', titulo: 'Divergência sem leitura atual do anúncio',
    orientacao: 'Não foi possível ler o anúncio agora. Tente de novo; se persistir, confira a conexão da conta/loja.' },
  real: { codigo: 'DIVERGENCIA_REAL', titulo: 'Divergência real (TMP10 × plataforma)',
    orientacao: 'Decida no painel do Estoque: "Enviar número do TMP10" (o anúncio passa a mostrar o TMP10), "Aceitar" (o número da plataforma vira o oficial, com movimento registrado) ou "Ignorar".' }
}

// Códigos e orientação para as mensagens da prévia do agrupamento (a mensagem já traz a causa e os valores)
const PADROES = [
  [/divergência\(s\) antiga\(s\) em anúncio FULL/, 'DIVERGENCIA_FULL', CLASSE_DIVERGENCIA.full.orientacao],
  [/já mostra o número atual do TMP10/, 'DIVERGENCIA_OBSOLETA', CLASSE_DIVERGENCIA.obsoleta.orientacao],
  [/reserva de promoção maior/, 'DIVERGENCIA_RESERVA_SHOPEE', CLASSE_DIVERGENCIA.reserva.orientacao],
  [/número de preenchimento/, 'DIVERGENCIA_PREENCHIMENTO', CLASSE_DIVERGENCIA.preenchimento.orientacao],
  [/estoque normal do TMP10 está negativo/, 'DIVERGENCIA_TMP10_NEGATIVO', CLASSE_DIVERGENCIA.tmp10_negativo.orientacao],
  [/sem leitura atual do anúncio/, 'DIVERGENCIA_SEM_LEITURA', CLASSE_DIVERGENCIA.sem_leitura.orientacao],
  [/divergência\(s\) NÃO resolvida|divergência\(s\) aberta/, 'DIVERGENCIA_REAL', CLASSE_DIVERGENCIA.real.orientacao],
  [/pedido\(s\) Full\/FBS ainda não importado/, 'PEDIDO_FULL_PENDENTE', 'Nada a fazer: venda Full/FBS não baixa o estoque normal.'],
  [/tipo \(Full ou comum\) não foi possível confirmar/, 'PEDIDO_TIPO_INCERTO', 'Aguarde a sincronização de pedidos (o TMP10 importa os pedidos sozinho) e gere a prévia de novo.'],
  [/pedido\(s\) ainda NÃO importado/, 'PEDIDO_PENDENTE', 'Aguarde a sincronização de pedidos (o TMP10 importa os pedidos sozinho) e gere a prévia de novo. Agrupar antes faria a baixa cair no produto errado.'],
  [/não foi possível confirmar os pedidos/, 'PEDIDOS_CONSULTA_FALHOU', 'Falha ao consultar os pedidos na plataforma (rede/token). Tente de novo em instantes; se persistir, reconecte a conta/loja.'],
  [/consulta do saldo Full falhou|confirmar se o anúncio é Full/, 'FULL_CONSULTA_FALHOU', 'A consulta do Full no ML falhou ou veio inconsistente. Tente de novo; o número NÃO é tratado como zero.'],
  [/não foi possível conferir as vendas Full/, 'FULL_VENDAS_FALHOU', 'Falha ao consultar o histórico de vendas Full no banco. Tente de novo; confira a migração 21/22 no diagnóstico.'],
  [/não confirma o saldo Full/, 'FULL_LOGISTICA_INCERTA', 'Deixe este anúncio fora do agrupamento ou confirme no Mercado Livre se ele ainda é Full. O envio do estoque normal para ele continua bloqueado enquanto o ML mostrar inventory_id.'],
  [/anúncio FULL \(inventory|Full indisponível para consulta/, 'FULL_SALDO', 'Informativo: o saldo Full fica no anúncio e não é somado.'],
  [/anúncio com vendas Full\/FBS/, 'FULL_VENDAS', 'Informativo: anúncio Full não recebe envio do TMP10.'],
  [/lista do PILOTO/, 'PRINCIPAL_NO_PILOTO', 'Tire o principal do PILOTO, agrupe, confira e decida depois (regra de segurança: agrupado nunca herda envio real).'],
  [/CONGELADO/, 'SALDO_CONGELADO', 'Informativo: o saldo do SKU secundário não é somado. Se as peças existem e não estão contadas no principal, ajuste o principal manualmente depois.'],
  [/SEM baixa/, 'VENDAS_SEM_BAIXA', 'Vendas que não baixaram estoque (SKU não cadastrado/ambíguo). Confira o estoque do principal depois.'],
  [/reservada\(s\) para promoção/, 'RESERVA_SHOPEE', 'Informativo: a fila nunca envia menos que a reserva da promoção.'],
  [/armazém da Shopee \(FBS\)/, 'FBS_SHOPEE', 'Informativo: anúncio com estoque no armazém da Shopee não recebe envio do TMP10.'],
  [/variação|variações|model_id/, 'VARIACAO', 'Vincule a variação certa ou deixe este anúncio fora (variações do ML estão fora desta versão).'],
  [/declara hoje o SKU/, 'SKU_DECLARADO_DIFERENTE', 'Corrija o SKU no anúncio ou o vínculo no TMP10 para que os pedidos cheguem com o SKU certo.'],
  [/mais de um SKU|vínculo ambíguo|não dá para saber a peça/, 'VINCULO_AMBIGUO', 'Corrija o vínculo: um anúncio/variação deve apontar para um único SKU.'],
  [/fora deste agrupamento|ficar dividido|continuariam agrupados/, 'SKU_DIVIDIDO', 'Inclua todos os anúncios do SKU (ou corrija o SKU nos anúncios): um SKU original nunca fica dividido.'],
  [/já está agrupado|é produto principal de outro|não se encadeiam/, 'JA_AGRUPADO', 'Desfaça o outro agrupamento antes, ou escolha aquele principal.'],
  [/não está cadastrado|não tem estoque oficial|mais de um produto com o SKU/, 'PRODUTO_PRINCIPAL', 'Corrija o cadastro do produto (SKU único e estoque oficial definido).'],
  [/não foi possível ler agora|não conectada/, 'LEITURA_FALHOU', 'Tente de novo; se persistir, reconecte a conta/loja.'],
  [/não encontrado entre os vínculos/, 'ANUNCIO_SEM_VINCULO', 'Importe o anúncio para o TMP10 antes.'],
  [/modo PILOTO|modo ATIVO|NÃO envia nada agora/, 'INFORMATIVO', 'Informativo.']
]
function codificar(item, tipo) {
  const m = String(item.motivo || '')
  const p = PADROES.find(([re]) => re.test(m))
  return { tipo, chave: item.chave || null, motivo: m, codigo: p ? p[1] : 'OUTRO', orientacao: p ? p[2] : 'Leia a causa descrita e corrija antes de tentar de novo.' }
}

// Tipo de um pedido ainda NÃO importado: { full: true | false | null, motivo }. Venda Full/FBS não baixa o estoque normal.
// ML: mesma regra do server.js (detectOrderType/isFulfillment) — tag 'meli_fulfillment' ou shipping.logistic_type 'fulfillment';
// sem isso, GET /shipments/{id}. Shopee: fulfillment_flag (FBS) já lido no detalhe do pedido. Sem confirmar → null.
async function tipoPedido(pd, { contas = [], ml = null } = {}) {
  if (pd.plataforma === 'shopee') return { full: !!pd.fbs }
  if ((pd.tags || []).includes('meli_fulfillment') || pd.logistica === 'fulfillment') return { full: true }
  if (pd.logistica) return { full: false }
  if (!pd.envio_id) return { full: null, motivo: 'o pedido não informa o envio' }
  const conta = contas.find((c) => c.platform !== 'shopee' && c.nickname === pd.conta && c.active === true)
  if (!conta || !ml || !ml.lerEnvio) return { full: null, motivo: 'conta do pedido não encontrada' }
  try { const e = await ml.lerEnvio(conta, pd.envio_id); return { full: e.full } } catch (e) { return { full: null, motivo: e.message } }
}

module.exports = { classificarDivergencia, CLASSE_DIVERGENCIA, codificar, tipoPedido, LIMITE_PREENCHIMENTO }
