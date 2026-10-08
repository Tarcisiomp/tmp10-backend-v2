-- TMP10 — DESFAZ a migração 22: apaga só as 2 funções da 22. A fila, o estoque e tudo mais ficam como estão.
-- Com a função removida, o backend volta sozinho a gravar a fila anúncio por anúncio (mais lento, mesmo resultado).
drop function if exists public.estoque_fila_enfileirar_lote(uuid, text[], text);
drop function if exists public.estoque_anuncios_full(uuid, integer);
