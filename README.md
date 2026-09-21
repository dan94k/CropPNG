# CropPNG — Asset Studio

Editor de recortes para spritesheets e assets de jogos, em HTML, CSS e JavaScript sem dependências. Todo processamento das imagens abertas pelo usuário ocorre no navegador; elas não são enviadas para um servidor.

## Rodar localmente

Na pasta do projeto:

```sh
python3 -m http.server 4173 --directory dist
```

Abra http://localhost:4173. É necessário servir os arquivos via HTTP para carregar os módulos JavaScript. Não há instalação nem build.

## Fluxo

1. Abra um PNG, JPG ou WebP, ou use o exemplo incluído.
2. Para um PNG com fundo transparente, clique em **Detectar em fundo transparente**. Regiões conectadas viram assets, preservando suas cores e transparência. A detecção ignora resíduos com menos de 12 pixels e limita cada execução a 250 regiões.
3. **Retângulo (R)**: arraste para criar um recorte; ele preserva o fundo existente.
4. **Contorno (P)**: clique ao redor da silhueta, pressione Enter ou clique no primeiro ponto para concluir. O exterior do contorno fica transparente. Em **Mover (V)**, arraste seus pontos para refinar. Backspace remove o último ponto durante o desenho; Esc cancela.
5. **Varinha (W)**: clique em uma região. Se houver transparência, seleciona o componente conectado. Em imagens opacas, seleciona cores próximas à cor do clique; ajuste a tolerância e clique novamente. Não é segmentação semântica por IA.
6. Selecione cada asset, renomeie, ajuste coordenadas e margem transparente. A remoção opcional de fundo usa as cores dos cantos do recorte; confira a prévia, especialmente em fundos com gradientes ou brilho.
7. Baixe um PNG ou use as caixas de seleção para exportar os assets desejados em um ZIP. Nomes repetidos recebem sufixos para não se sobrescreverem.

Ctrl/Cmd+Z desfaz, Ctrl/Cmd+Shift+Z refaz, Delete exclui a seleção. Os recortes são temporários e não persistem após fechar/recarregar a página; há aviso antes de sair. Abrir outra imagem solicita confirmação quando existem recortes.

## Limites

- Até 16 megapixels e 8192 pixels por dimensão. A resolução original é preservada na exportação.
- Assets que se tocam formam uma região única na detecção automática; separe-os manualmente.
- Partes desconectadas de um mesmo asset são detectadas separadamente. Use um retângulo ou contorno englobando todas as partes para agrupá-las.
- Imagens com fundo complexo não têm extração automática perfeita. Use contorno manual; a varinha reconhece cores conectadas, não objetos completos.
- A detecção de transparência usa limiar de alfa 8/255 para ignorar ruído quase invisível.
- A opção de remoção de fundo é adequada a fundos simples; pode remover cores do próprio asset quando são parecidas com os cantos.
- A prévia usa o navegador; os arquivos exportados mantêm as dimensões originais com a margem escolhida.

## Verificação

```sh
node --test tests/core.test.mjs
```

Testes cobrem componentes transparentes, conectividade diagonal, seleção por cor, prevenção de vazamento entre linhas, remoção de fundo e integridade ZIP/CRC. A interface também expõe ferramentas WebMCP opcionais para listar recortes e adicionar retângulos à revisão; navegadores sem suporte seguem funcionando normalmente.
