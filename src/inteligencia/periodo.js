// Períodos do TMP10 no horário de Brasília (UTC-3, sem horário de verão desde 2019).
// Devolve sempre { ini, fim } como Date (UTC) e o dia de início/fim no formato AAAA-MM-DD (horário de Brasília).
const OFFSET_MS = 3 * 60 * 60 * 1000
const DIA_MS = 24 * 60 * 60 * 1000
const PERIODOS = ['hoje', 'ontem', 'semana', 'mes', 'ano', 'personalizado']

// Data "de calendário" em Brasília para um instante
function diaBrasilia(instante) {
  return new Date(instante.getTime() - OFFSET_MS).toISOString().slice(0, 10)
}
// Início (00:00 Brasília) de um dia AAAA-MM-DD, em UTC
function inicioDoDia(dia) { return new Date(dia + 'T03:00:00.000Z') }
function fimDoDia(dia) { return new Date(inicioDoDia(dia).getTime() + DIA_MS - 1) }
function somarDias(dia, n) { return new Date(Date.parse(dia + 'T12:00:00Z') + n * DIA_MS).toISOString().slice(0, 10) }
const valido = (s) => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s } // recusa 2026-02-31

function resolverPeriodo({ periodo = 'mes', de, ate } = {}, agora = new Date()) {
  const hoje = diaBrasilia(agora)
  let d1, d2
  switch (periodo) {
    case 'hoje': d1 = d2 = hoje; break
    case 'ontem': d1 = d2 = somarDias(hoje, -1); break
    case 'semana': d1 = somarDias(hoje, -6); d2 = hoje; break
    case 'mes': d1 = hoje.slice(0, 8) + '01'; d2 = hoje; break
    case 'ano': d1 = hoje.slice(0, 5) + '01-01'; d2 = hoje; break
    case 'personalizado':
      if (!valido(de) || !valido(ate)) throw Object.assign(new Error('Informe as datas no formato AAAA-MM-DD.'), { status: 400 })
      if (de > ate) throw Object.assign(new Error('A data inicial é depois da final.'), { status: 400 })
      d1 = de; d2 = ate
      if ((inicioDoDia(d2) - inicioDoDia(d1)) / DIA_MS > 400) throw Object.assign(new Error('Período máximo: 400 dias.'), { status: 400 })
      break
    default: throw Object.assign(new Error('Período inválido. Use: ' + PERIODOS.join(', ')), { status: 400 })
  }
  const ini = inicioDoDia(d1), fim = fimDoDia(d2)
  return { periodo, de: d1, ate: d2, ini, fim, dias: Math.round((fim - ini + 1) / DIA_MS) }
}

module.exports = { resolverPeriodo, diaBrasilia, inicioDoDia, fimDoDia, somarDias, PERIODOS, DIA_MS }
