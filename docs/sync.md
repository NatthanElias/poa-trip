# Sincronização das paradas

Cada aparelho mantém um registro por parada em memória e no `localStorage`. Cada registro contém a marcação, um timestamp e o identificador do aparelho. O timestamp mais alto vence. Em caso de empate, o identificador e a marcação definem uma ordem igual em todos os aparelhos.

O [textdb](https://textdb.dev/) guarda uma cópia JSON do grupo. Cada sincronização lê essa cópia, incorpora registros mais recentes e reenvia os registros locais que faltam no servidor. Após escrever, o aparelho confere a cópia novamente. Uma notificação pelo [ntfy](https://docs.ntfy.sh/subscribe/api/) pede aos outros aparelhos que façam a mesma consulta.

As consultas também acontecem a cada 60 segundos enquanto a página está visível, ao voltar à aba e ao recuperar a conexão. Falhas geram novas tentativas, com intervalo de 2 a 60 segundos. Uma alteração durante um envio provoca outra rodada de sincronização. Cada requisição tem limite de 12 segundos.

## Limites da escolha

Esta implementação atende a uma viagem curta de um grupo pequeno. Os serviços externos são necessários para compartilhar as marcações. O roteiro e as marcações locais continuam utilizáveis quando a sincronização está indisponível, desde que a página já esteja aberta. O aplicativo não oferece instalação nem carregamento completo sem internet.

Os endereços de escrita são públicos no HTML. Qualquer pessoa que os obtenha pode alterar as marcações. Esses registros não devem conter informações privadas.

O textdb substitui a cópia inteira e não oferece uma transação nesta integração. Escritas simultâneas podem sobrescrever registros no servidor. Um aparelho que ainda tenha os registros perdidos os restaura na próxima sincronização. Se todos os aparelhos com esses registros desaparecerem antes da restauração, a recuperação não é garantida. Um banco com transações e autenticação seria necessário para uma garantia mais forte.

O relógio do aparelho influencia a ordem de alterações conflitantes. Cada nova alteração supera os timestamps já conhecidos pelo aparelho, mas um aparelho com relógio adiantado pode vencer uma alteração ainda desconhecida. Não existe histórico de desfazer.

Quando o armazenamento do navegador está bloqueado, o registro permanece em memória durante a sessão. Fechar a página antes de enviar pode perder essa alteração.

## Revisão e evidências

A revisão corrigiu a ausência de reenvio após falha, a perda de alterações feitas durante um upload, a falta de reparação de cópias concorrentes e os empates de timestamp. Registros remotos desconhecidos ou inválidos são ignorados. Uma cópia JSON inválida não é substituída automaticamente.

O teste herdado conectava os dois clientes ao primeiro alvo do Chrome. Seus resultados não comprovavam sincronização entre aparelhos. O teste atual cria dois contextos isolados, verifica identificadores distintos e usa endereços descartáveis dos serviços reais, sem alterar as marcações do grupo.

## Executar os testes

Na raiz do projeto, execute os testes de falhas e conflitos com Node.js:

```sh
node --test tests/sync.test.cjs
```

Com Chromium disponível na porta de depuração 9222, execute o teste dos serviços reais contra a página publicada:

```sh
node tests/browser-sync.mjs https://natthanelias.github.io/poa-trip/
```

Esse teste verifica atualização nos dois sentidos, desmarcação, alterações simultâneas, reenvio após desconexão e persistência após recarregar. Ele cria dois contextos temporários e os fecha ao terminar.
