/* =====================================================================
   Testing of tables: United Tables (tiers)
   Doc: https://e-conomic.slite.com/app/docs/qOrGOdqMmd

   Antes de correr:
   1. MIM portal: GCP-416384539595-DeveloperPrivileged ativo (dura 1 dia).
   2. Túnel aberto num terminal:
      gcloud compute start-iap-tunnel --project qa-econo-cm --zone europe-north2-a sql-server-qa16 1433 --local-host-port=localhost:2016
   3. Ligar no SSMS / VS Code (extensão mssql) a  127.0.0.1,2016
      SQL login, user/password do Spook: acceptance / qa03 / sql_server/patch-system

   As tabelas #temp só existem na tua sessão: nada muda na base partilhada.
   Códigos: Flow 1 Bank, 2 Document | Lifecycle 1 Open, 2 Processed,
   3 ClosedWithoutBooking, 4 ConsumedByBankLine, 5 Removed |
   Tier 1 Fully, 2 A1, 3 A2, 4 A3, 5 Manual
   ===================================================================== */
SET NOCOUNT ON;

/* ---------- 1. Sanity check ---------- */
SELECT @@SERVERNAME AS server, DB_NAME() AS db, SUSER_SNAME() AS login;
-- Se db não for a base do monólito: SELECT name FROM sys.databases;  e depois  USE [nome];

/* ---------- 2. Tabelas e colunas de origem existem? ---------- */
SELECT t.name AS expected_table, CASE WHEN o.object_id IS NULL THEN 'EM FALTA' ELSE 'ok' END AS status
FROM (VALUES ('BankafstemningBank'), ('BilagsBillede'), ('Postering'), ('BankEntryDocument'),
             ('BankReconciliationMatch'), ('BankEntryWorkflowStatus'), ('Opsaetning'), ('AdministratorGruppe')) AS t(name)
LEFT JOIN sys.tables AS o ON o.name = t.name;

SELECT c.name AS expected_column,
       ISNULL(STRING_AGG(tb.name, ', '), 'EM FALTA') AS found_in_tables
FROM (VALUES ('CreatedAtUTC'), ('IsDeleted'), ('FalskPostering'), ('Afstemt'), ('KladdePostering'),
             ('BilledNr'), ('CreationDate'), ('DeletedAt'), ('Status'), ('ScanningStatus'),
             ('SourceType'), ('AttachmentSource'), ('TagId'), ('Method')) AS c(name)
LEFT JOIN sys.columns AS sc ON sc.name = c.name
LEFT JOIN sys.tables  AS tb ON tb.object_id = sc.object_id
      AND tb.name IN ('BankafstemningBank', 'BilagsBillede', 'Postering', 'BankEntryDocument',
                      'BankReconciliationMatch', 'BankEntryWorkflowStatus', 'Opsaetning', 'AdministratorGruppe')
GROUP BY c.name
ORDER BY c.name;
-- Nota: BankReconciliationMatch.Method (S8) só existe depois do go-live (~fim out 2026).

/* ---------- 3. Tabela 1 em temp, com as regras do doc como CHECKs ---------- */
DROP TABLE IF EXISTS #AgreementAutomationMonthly;
DROP TABLE IF EXISTS #WorkItemAutomationFact;

CREATE TABLE #WorkItemAutomationFact (
    SetupId         int          NOT NULL,
    AgreementNo     int          NOT NULL,
    Flow            tinyint      NOT NULL CHECK (Flow IN (1, 2)),
    ItemId          bigint       NOT NULL,
    ArrivalMonth    date         NOT NULL CHECK (DAY(ArrivalMonth) = 1),
    ArrivedAtUtc    datetime2(0) NOT NULL,
    Lifecycle       tinyint      NOT NULL CHECK (Lifecycle BETWEEN 1 AND 5),
    OpenSubStatus   tinyint      NULL,
    ProcessedAtUtc  datetime2(0) NULL,
    Tier            tinyint      NULL CHECK (Tier BETWEEN 1 AND 5),
    TierSignal      tinyint      NULL CHECK (TierSignal BETWEEN 0 AND 8),
    ManualReason    tinyint      NULL CHECK (ManualReason BETWEEN 1 AND 7),
    ApprovalByHuman bit          NOT NULL DEFAULT 0,
    MetricVersion   smallint     NOT NULL DEFAULT 1,
    ComputedAtUtc   datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY (ArrivalMonth, SetupId, Flow, ItemId),
    -- Tier e ProcessedAtUtc só quando Processed
    CHECK ((Lifecycle = 2 AND Tier IS NOT NULL AND ProcessedAtUtc IS NOT NULL)
        OR (Lifecycle <> 2 AND Tier IS NULL AND ProcessedAtUtc IS NULL)),
    -- OpenSubStatus só quando Open
    CHECK (Lifecycle = 1 OR OpenSubStatus IS NULL),
    -- ConsumedByBankLine e ClosedWithoutBooking só para documentos
    CHECK (Lifecycle NOT IN (3, 4) OR Flow = 2),
    -- ManualReason só quando Manual
    CHECK (Tier = 5 OR ManualReason IS NULL),
    -- Sinal bate com o tier: Fully 0, A1 S1-S2, A2 S3-S6, A3 S7-S8, Manual NULL
    CHECK ((Tier IS NULL AND TierSignal IS NULL)
        OR (Tier = 1 AND TierSignal = 0)
        OR (Tier = 2 AND TierSignal IN (1, 2))
        OR (Tier = 3 AND TierSignal BETWEEN 3 AND 6)
        OR (Tier = 4 AND TierSignal IN (7, 8))
        OR (Tier = 5 AND TierSignal IS NULL))
);

-- Exemplos da secção 2 do doc (um cliente, setembro 2026)
INSERT INTO #WorkItemAutomationFact
    (SetupId, AgreementNo, Flow, ItemId, ArrivalMonth, ArrivedAtUtc, Lifecycle, OpenSubStatus, ProcessedAtUtc, Tier, TierSignal, ManualReason, ApprovalByHuman)
VALUES
    (1, 1001, 1,  1, '2026-09-01', '2026-09-02', 2, NULL, '2026-09-02', 1, 0,    NULL, 0),  -- Fully
    (1, 1001, 2,  2, '2026-09-01', '2026-09-03', 2, NULL, '2026-09-04', 1, 0,    NULL, 1),  -- Fully com aprovação
    (1, 1001, 1,  3, '2026-09-01', '2026-09-05', 2, NULL, '2026-09-06', 2, 1,    NULL, 0),  -- A1 corrigido (S1)
    (1, 1001, 1,  4, '2026-09-01', '2026-09-05', 2, NULL, '2026-09-07', 2, 2,    NULL, 0),  -- A1 preparado (S2)
    (1, 1001, 2,  5, '2026-09-01', '2026-09-08', 2, NULL, '2026-09-09', 3, 5,    NULL, 0),  -- A2 SmartScan (S5)
    (1, 1001, 1,  6, '2026-09-01', '2026-09-08', 2, NULL, '2026-09-09', 3, 3,    NULL, 0),  -- A2 AutoSuggest (S3)
    (1, 1001, 2,  7, '2026-09-01', '2026-09-10', 2, NULL, '2026-09-11', 4, 7,    NULL, 0),  -- A3 AutoAttach (S7)
    (1, 1001, 1,  8, '2026-09-01', '2026-09-10', 2, NULL, '2026-09-12', 5, NULL, 1,    0),  -- Manual
    (1, 1001, 2,  9, '2026-09-01', '2026-09-12', 1, 1,    NULL,         NULL, NULL, NULL, 0),  -- Open
    (1, 1001, 1, 10, '2026-09-01', '2026-09-13', 5, NULL, NULL,         NULL, NULL, NULL, 0),  -- Removed
    (1, 1001, 2, 11, '2026-09-01', '2026-09-14', 4, NULL, NULL,         NULL, NULL, NULL, 0),  -- ConsumedByBankLine
    (1, 1001, 2, 12, '2026-09-01', '2026-09-15', 2, NULL, '2026-09-16', 3, 4,    NULL, 0);  -- A2 conta de telefone (S4)

/* ---------- Testes negativos: cada linha tem de ser REJEITADA ---------- */
DECLARE @tests TABLE (name varchar(60), sql nvarchar(max));
INSERT INTO @tests VALUES
 ('Tier num item Open',           N'(1,1001,1,90,''2026-09-01'',''2026-09-01'',1,NULL,NULL,1,0,NULL,0)'),
 ('A2 com sinal de A3 (S7)',      N'(1,1001,2,91,''2026-09-01'',''2026-09-01'',2,NULL,''2026-09-02'',3,7,NULL,0)'),
 ('ManualReason fora de Manual',  N'(1,1001,1,92,''2026-09-01'',''2026-09-01'',2,NULL,''2026-09-02'',2,2,1,0)'),
 ('ConsumedByBankLine num banco', N'(1,1001,1,93,''2026-09-01'',''2026-09-01'',4,NULL,NULL,NULL,NULL,NULL,0)'),
 ('Manual com TierSignal',        N'(1,1001,1,94,''2026-09-01'',''2026-09-01'',2,NULL,''2026-09-02'',5,3,3,0)');

DECLARE @results TABLE (test varchar(60), result varchar(30));
DECLARE @name varchar(60), @vals nvarchar(max);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT name, sql FROM @tests;
OPEN c; FETCH NEXT FROM c INTO @name, @vals;
WHILE @@FETCH_STATUS = 0
BEGIN
    BEGIN TRY
        EXEC (N'INSERT INTO #WorkItemAutomationFact (SetupId, AgreementNo, Flow, ItemId, ArrivalMonth, ArrivedAtUtc, Lifecycle, OpenSubStatus, ProcessedAtUtc, Tier, TierSignal, ManualReason, ApprovalByHuman) VALUES ' + @vals);
        INSERT INTO @results VALUES (@name, 'FALHOU: foi aceite');
    END TRY
    BEGIN CATCH
        INSERT INTO @results VALUES (@name, 'ok: rejeitada');
    END CATCH;
    FETCH NEXT FROM c INTO @name, @vals;
END
CLOSE c; DEALLOCATE c;
SELECT * FROM @results;

/* ---------- Tabela 2 a partir da tabela 1 ---------- */
SELECT AgreementNo, SetupId, ArrivalMonth AS MonthStart, Flow,
       COUNT(*)                                        AS Arrived,
       SUM(CASE WHEN Lifecycle = 5 THEN 1 ELSE 0 END)  AS Removed,
       SUM(CASE WHEN Lifecycle = 4 THEN 1 ELSE 0 END)  AS ConsumedByBankLine,
       SUM(CASE WHEN Lifecycle = 3 THEN 1 ELSE 0 END)  AS ClosedWithoutBooking,
       SUM(CASE WHEN Lifecycle = 1 THEN 1 ELSE 0 END)  AS OpenItems,
       SUM(CASE WHEN Lifecycle = 2 THEN 1 ELSE 0 END)  AS Processed,
       SUM(CASE WHEN Tier = 1 THEN 1 ELSE 0 END)       AS Fully,
       SUM(CASE WHEN Tier = 2 THEN 1 ELSE 0 END)       AS AssistedA1,
       SUM(CASE WHEN Tier = 3 THEN 1 ELSE 0 END)       AS AssistedA2,
       SUM(CASE WHEN Tier = 4 THEN 1 ELSE 0 END)       AS AssistedA3,
       SUM(CASE WHEN Tier = 5 THEN 1 ELSE 0 END)       AS Manual,
       SUM(CASE WHEN Tier = 1 AND ApprovalByHuman = 1 THEN 1 ELSE 0 END) AS FullyWithHumanApproval,
       SUM(CASE WHEN Tier = 2 AND TierSignal = 1 THEN 1 ELSE 0 END)      AS AutoBookedThenCorrected
INTO #AgreementAutomationMonthly
FROM #WorkItemAutomationFact
GROUP BY AgreementNo, SetupId, ArrivalMonth, Flow;

SELECT * FROM #AgreementAutomationMonthly ORDER BY Flow;

/* ---------- Invariantes e headline ---------- */
SELECT 'Processed = Fully+A1+A2+A3+Manual' AS check_name,
       CASE WHEN EXISTS (SELECT 1 FROM #AgreementAutomationMonthly
                         WHERE Processed <> Fully + AssistedA1 + AssistedA2 + AssistedA3 + Manual) THEN 'FALHOU' ELSE 'ok' END AS result
UNION ALL
SELECT 'Arrived = soma dos lifecycles',
       CASE WHEN EXISTS (SELECT 1 FROM #AgreementAutomationMonthly
                         WHERE Arrived <> Removed + ConsumedByBankLine + ClosedWithoutBooking + OpenItems + Processed) THEN 'FALHOU' ELSE 'ok' END
UNION ALL
SELECT 'Banco sem Consumed/Closed',
       CASE WHEN EXISTS (SELECT 1 FROM #AgreementAutomationMonthly
                         WHERE Flow = 1 AND (ConsumedByBankLine <> 0 OR ClosedWithoutBooking <> 0)) THEN 'FALHOU' ELSE 'ok' END;

-- Headline: (Fully + A1 + A2 + A3) / Processed, somando os dois fluxos antes de dividir.
-- Esperado com os exemplos: 9 processados, AutomationRatePct 88.9, FullyPct 22.2
SELECT AgreementNo, MonthStart,
       SUM(Processed) AS Processed,
       CAST(100.0 * SUM(Fully + AssistedA1 + AssistedA2 + AssistedA3) / NULLIF(SUM(Processed), 0) AS decimal(5,1)) AS AutomationRatePct,
       CAST(100.0 * SUM(Fully) / NULLIF(SUM(Processed), 0) AS decimal(5,1)) AS FullyPct
FROM #AgreementAutomationMonthly
GROUP BY AgreementNo, MonthStart;

/* ---------- 4. Dados reais (fluxo Banco): chegadas e removidos por mês ----------
   Confirma no passo 2 onde estão IsDeleted / FalskPostering e ajusta antes de correr. */
SELECT TOP 24
       m.ArrivalMonth,
       COUNT(*) AS Arrived,
       SUM(CASE WHEN b.IsDeleted = 1 OR b.FalskPostering = '1' THEN 1 ELSE 0 END) AS Removed
FROM BankafstemningBank AS b
CROSS APPLY (SELECT CAST(b.CreatedAtUTC AS datetime2) AT TIME ZONE 'UTC' AT TIME ZONE 'Romance Standard Time' AS LocalTime) AS l
CROSS APPLY (SELECT DATEFROMPARTS(YEAR(l.LocalTime), MONTH(l.LocalTime), 1) AS ArrivalMonth) AS m
WHERE b.CreatedAtUTC >= '2025-07-01'
GROUP BY m.ArrivalMonth
ORDER BY m.ArrivalMonth DESC;
