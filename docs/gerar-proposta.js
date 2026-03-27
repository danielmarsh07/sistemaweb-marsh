const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, WidthType, BorderStyle,
  ShadingType, PageNumber, NumberFormat, TableBorders, convertInchesToTwip,
  ImageRun
} = require('docx');
const fs = require('fs');

// ===== CORES MARSH =====
const COR_NAVY    = '0D1B2A';
const COR_BLUE    = '0D6EFD';
const COR_CYAN    = '00C8FF';
const COR_BRANCO  = 'FFFFFF';
const COR_CINZA   = 'F1F5F9';
const COR_TEXTO   = '1E293B';
const COR_SUBTXT  = '475569';

// ===== DADOS DA PROPOSTA =====
// Edite aqui para cada cliente
const PROPOSTA = {
  titulo:       'Proposta Comercial',
  subtitulo:    'Sistema Web para Clínica de Estética',
  cliente:      'Nome da Clínica',
  data:         'Março/2026',
  validade:     '30 dias',
  responsavel:  'Daniel Marsh',

  secoes: [
    {
      titulo: 'Sobre a Marsh Consultoria',
      conteudo: [
        'A Marsh Consultoria é especializada em desenvolvimento de sistemas web, consultoria SAP e automação de processos. Nosso compromisso é entregar soluções tecnológicas sob medida, com qualidade, prazo e suporte contínuo.',
        'Sediada em Bragança Paulista – SP, atendemos clientes em todo o Brasil com uma abordagem próxima, ágil e orientada a resultados.'
      ]
    },
    {
      titulo: 'O que será entregue',
      conteudo: [
        '• Landing page profissional com identidade visual da clínica (cores, tipografia, layout)',
        '• Seções: serviços, equipe de profissionais, localização, depoimentos de clientes',
        '• Botão de WhatsApp em destaque para contato direto',
        '• Sistema interno: cadastro de pacientes, profissionais e agenda',
        '• Histórico de atendimentos por paciente',
        '• Controle financeiro básico de entradas',
        '• Totalmente responsivo — funciona no celular e computador',
        '• Instalável como app no celular (sem precisar da loja de apps)'
      ]
    },
    {
      titulo: 'Investimento',
      tabela: [
        ['Serviço',                          'Valor'],
        ['Landing page profissional',        'R$ 1.500,00'],
        ['Sistema completo (agenda + financeiro)', 'R$ 2.000,00'],
        ['TOTAL DO PROJETO',                 'R$ 3.500,00'],
      ]
    },
    {
      titulo: 'Suporte Mensal',
      tabela: [
        ['Plano',    'O que inclui',                              'Valor/mês'],
        ['Básico',   'Hospedagem + manutenção corretiva',         'R$ 200,00'],
        ['Padrão',   'Básico + melhorias mensais',                'R$ 350,00'],
        ['Premium',  'Padrão + suporte prioritário + relatórios', 'R$ 700,00'],
      ]
    },
    {
      titulo: 'Forma de Pagamento',
      conteudo: [
        '• Desenvolvimento: 50% na assinatura do contrato + 50% na entrega',
        '• Mensalidade: via Pix ou boleto recorrente (Mercado Pago / Asaas)',
        '• Prazo estimado de entrega: 15 a 20 dias úteis após aprovação'
      ]
    },
    {
      titulo: 'Próximos Passos',
      conteudo: [
        '1. Aprovação desta proposta',
        '2. Assinatura do contrato e pagamento da entrada',
        '3. Reunião de briefing para coleta de informações e identidade visual',
        '4. Desenvolvimento e apresentação de protótipo',
        '5. Ajustes e entrega final com treinamento'
      ]
    }
  ]
};

// ===== HELPERS =====
function hrLine() {
  return new Paragraph({
    border: { bottom: { color: COR_BLUE, size: 6, style: BorderStyle.SINGLE } },
    spacing: { after: 200 }
  });
}

function espacamento(pts = 200) {
  return new Paragraph({ spacing: { after: pts } });
}

function titSecao(texto) {
  return new Paragraph({
    children: [
      new TextRun({
        text: texto,
        bold: true,
        size: 26,
        color: COR_NAVY,
        font: 'Calibri'
      })
    ],
    spacing: { before: 400, after: 160 },
    border: { bottom: { color: COR_CYAN, size: 4, style: BorderStyle.SINGLE } }
  });
}

function paragrafo(texto, cor = COR_TEXTO) {
  return new Paragraph({
    children: [
      new TextRun({
        text: texto,
        size: 22,
        color: cor,
        font: 'Calibri'
      })
    ],
    spacing: { after: 140 }
  });
}

function gerarTabela(linhas) {
  const ehCabecalho = (i) => i === 0;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TableBorders.NONE,
    rows: linhas.map((linha, i) =>
      new TableRow({
        children: linha.map(celula =>
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: celula,
                    bold: ehCabecalho(i),
                    size: ehCabecalho(i) ? 22 : 21,
                    color: ehCabecalho(i) ? COR_BRANCO : COR_TEXTO,
                    font: 'Calibri'
                  })
                ],
                alignment: AlignmentType.LEFT,
                spacing: { before: 80, after: 80 }
              })
            ],
            shading: ehCabecalho(i)
              ? { fill: COR_NAVY, type: ShadingType.CLEAR }
              : { fill: i % 2 === 0 ? COR_CINZA : COR_BRANCO, type: ShadingType.CLEAR },
            margins: {
              top: convertInchesToTwip(0.05),
              bottom: convertInchesToTwip(0.05),
              left: convertInchesToTwip(0.1),
              right: convertInchesToTwip(0.1)
            }
          })
        )
      })
    )
  });
}

// ===== CABEÇALHO =====
function gerarHeader() {
  return new Header({
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: TableBorders.NONE,
        rows: [
          new TableRow({
            children: [
              // Logo M
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ text: 'M', bold: true, size: 48, color: COR_BRANCO, font: 'Calibri' }),
                      new TextRun({ text: '  Marsh ', bold: false, size: 28, color: COR_BRANCO, font: 'Calibri' }),
                      new TextRun({ text: 'Consultoria', bold: true, size: 28, color: COR_CYAN, font: 'Calibri' }),
                    ],
                    alignment: AlignmentType.LEFT
                  })
                ],
                shading: { fill: COR_NAVY, type: ShadingType.CLEAR },
                margins: {
                  top: convertInchesToTwip(0.1),
                  bottom: convertInchesToTwip(0.1),
                  left: convertInchesToTwip(0.15),
                  right: convertInchesToTwip(0.1)
                }
              }),
              // Contato
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ text: 'daniel.marsh@marshconsultoria.com.br', size: 16, color: COR_BRANCO, font: 'Calibri' })
                    ],
                    alignment: AlignmentType.RIGHT
                  }),
                  new Paragraph({
                    children: [
                      new TextRun({ text: '(21) 96780-6718  |  Bragança Paulista – SP', size: 16, color: COR_CYAN, font: 'Calibri' })
                    ],
                    alignment: AlignmentType.RIGHT
                  })
                ],
                shading: { fill: COR_NAVY, type: ShadingType.CLEAR },
                margins: {
                  top: convertInchesToTwip(0.1),
                  bottom: convertInchesToTwip(0.1),
                  left: convertInchesToTwip(0.1),
                  right: convertInchesToTwip(0.15)
                }
              })
            ]
          })
        ]
      })
    ]
  });
}

// ===== RODAPÉ =====
function gerarFooter() {
  return new Footer({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: '© 2026 Marsh Consultoria  |  Todos os direitos reservados  |  Página ', size: 16, color: COR_SUBTXT, font: 'Calibri' }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: COR_SUBTXT, font: 'Calibri' }),
          new TextRun({ text: ' de ', size: 16, color: COR_SUBTXT, font: 'Calibri' }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: COR_SUBTXT, font: 'Calibri' }),
        ],
        alignment: AlignmentType.CENTER,
        border: { top: { color: COR_BLUE, size: 4, style: BorderStyle.SINGLE } },
        spacing: { before: 120 }
      })
    ]
  });
}

// ===== CAPA =====
function gerarCapa() {
  return [
    espacamento(1200),
    new Paragraph({
      children: [
        new TextRun({ text: PROPOSTA.titulo.toUpperCase(), bold: true, size: 52, color: COR_NAVY, font: 'Calibri' })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: PROPOSTA.subtitulo, size: 32, color: COR_BLUE, font: 'Calibri' })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Preparado para: ', size: 24, color: COR_SUBTXT, font: 'Calibri' }),
        new TextRun({ text: PROPOSTA.cliente, bold: true, size: 24, color: COR_NAVY, font: 'Calibri' })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Data: ', size: 22, color: COR_SUBTXT, font: 'Calibri' }),
        new TextRun({ text: PROPOSTA.data, size: 22, color: COR_TEXTO, font: 'Calibri' })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Validade: ', size: 22, color: COR_SUBTXT, font: 'Calibri' }),
        new TextRun({ text: PROPOSTA.validade, size: 22, color: COR_TEXTO, font: 'Calibri' })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Responsável: ', size: 22, color: COR_SUBTXT, font: 'Calibri' }),
        new TextRun({ text: PROPOSTA.responsavel, bold: true, size: 22, color: COR_NAVY, font: 'Calibri' })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 }
    }),
    hrLine()
  ];
}

// ===== CORPO =====
function gerarCorpo() {
  const elementos = [];

  for (const secao of PROPOSTA.secoes) {
    elementos.push(titSecao(secao.titulo));

    if (secao.conteudo) {
      for (const linha of secao.conteudo) {
        elementos.push(paragrafo(linha));
      }
    }

    if (secao.tabela) {
      elementos.push(gerarTabela(secao.tabela));
      elementos.push(espacamento(200));
    }
  }

  return elementos;
}

// ===== GERAR DOCUMENTO =====
async function gerarDocumento() {
  const doc = new Document({
    sections: [
      {
        headers: { default: gerarHeader() },
        footers: { default: gerarFooter() },
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1.2),
              bottom: convertInchesToTwip(0.9),
              left: convertInchesToTwip(1),
              right: convertInchesToTwip(1)
            }
          }
        },
        children: [
          ...gerarCapa(),
          espacamento(400),
          ...gerarCorpo()
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  const nomeArquivo = `proposta-${PROPOSTA.subtitulo.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.docx`;
  fs.writeFileSync(nomeArquivo, buffer);
  console.log(`✅ Documento gerado: ${nomeArquivo}`);
}

gerarDocumento().catch(console.error);
