"use client";

import { diagnosisText, formatDate, formatDateTime, PHRASE_TARGET_LABELS, prescriptionText } from "../lib/format";

export function ComparePanel({ changes, previous }) {
  if (!previous) {
    return (
      <section className="panel">
        <h2>前回との比較</h2>
        <p className="empty">確定済みの前回カルテはありません。</p>
      </section>
    );
  }
  const exam = previous.content.exam;
  return (
    <section className="panel">
      <h2>前回との比較</h2>
      <p className="muted small">前回 {formatDate(previous.encounterDate)}（v{previous.versionCount}）</p>
      <h3>今回変わった所</h3>
      {changes.length === 0 ? <p className="muted small">変更はまだありません。</p> : (
        <ul className="changes">
          {changes.map((change) => (
            <li key={change.path}>
              <span className="change-label">{change.label}</span>
              <span className="change-values"><del>{change.before || "（空）"}</del> → <ins>{change.after || "（空）"}</ins></span>
            </li>
          ))}
        </ul>
      )}
      <h3>前回の記録</h3>
      <dl className="prev-list">
        <dt>視力</dt>
        <dd>R {exam.od.vaCorrected || exam.od.vaUncorrected || "—"} / L {exam.os.vaCorrected || exam.os.vaUncorrected || "—"}</dd>
        <dt>眼圧</dt>
        <dd>R {exam.od.iop ?? "—"} / L {exam.os.iop ?? "—"}</dd>
        <dt>病名</dt>
        <dd>{previous.content.diagnoses.map(diagnosisText).join("、") || "—"}</dd>
        <dt>処方</dt>
        <dd>{previous.content.prescriptions.map(prescriptionText).join("、") || "—"}</dd>
        <dt>方針</dt>
        <dd>{previous.content.plan || "—"}</dd>
      </dl>
      <a className="small" href={`/encounters/${previous.encounterId}`}>前回カルテを開く</a>
    </section>
  );
}

export function VersionsPanel({ encounterId, versions }) {
  if (!versions.length) return null;
  return (
    <section className="panel">
      <h2>確定履歴</h2>
      <ol className="versions">
        {[...versions].reverse().map((version) => (
          <li key={version.versionId}>
            <a href={`/encounters/${encounterId}/print?version=${version.version}`} target="_blank" rel="noreferrer">v{version.version}</a>
            <span className="muted small"> {formatDateTime(version.finalizedAt)} {version.finalizedBy?.displayName}</span>
            {version.amendmentReason ? <div className="small">修正理由: {version.amendmentReason}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}


const COPY_ACTIONS = [
  ["findings", "所見"],
  ["prescriptions", "処方"],
  ["plan", "方針"],
  ["sketches", "シェーマ"]
];

// 左列: 過去の確定カルテ。項目ごとに今回のカルテへ複写できる（Do）。
export function HistoryPane({ history, editable, onCopy }) {
  if (!history.length) {
    return <p className="empty">確定済みの過去カルテはありません。</p>;
  }
  return (
    <ol className="history-pane">
      {history.map((encounter) => {
        const { content } = encounter;
        const findings = ["od", "os"].flatMap((side) => (
          [["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]]
            .filter(([key]) => content.findings?.[side]?.[key])
            .map(([key, label]) => `${side === "od" ? "R" : "L"} ${label}: ${content.findings[side][key]}`)
        ));
        return (
          <li className="history-card" key={encounter.encounterId}>
            <div className="history-card-head">
              <strong>{formatDate(encounter.encounterDate)}</strong>
              <span className="muted small">v{encounter.versionCount} {encounter.finalizedBy?.displayName || ""}</span>
              {editable ? <button className="btn btn-chip" onClick={() => onCopy("all", encounter)} type="button">すべて複写</button> : null}
            </div>
            <p className="history-line">
              <span className="eye-od">R</span> {content.exam.od.vaCorrected || content.exam.od.vaUncorrected || "—"} / {content.exam.od.iop ?? "—"}
              {"　"}
              <span className="eye-os">L</span> {content.exam.os.vaCorrected || content.exam.os.vaUncorrected || "—"} / {content.exam.os.iop ?? "—"}
              <span className="muted small">（視力 / 眼圧）</span>
            </p>
            {content.chiefComplaint ? <p className="history-line"><span className="history-label">主訴</span>{content.chiefComplaint}</p> : null}
            {findings.length ? <p className="history-line pre"><span className="history-label">所見</span>{findings.join("\n")}</p> : null}
            {content.diagnoses?.length ? <p className="history-line"><span className="history-label">病名</span>{content.diagnoses.map(diagnosisText).join("、")}</p> : null}
            {content.prescriptions?.length ? <p className="history-line"><span className="history-label">処方</span>{content.prescriptions.map(prescriptionText).join("、")}</p> : null}
            {content.plan ? <p className="history-line pre"><span className="history-label">方針</span>{content.plan}</p> : null}
            {content.sketches?.length ? <p className="history-line muted small">シェーマ {content.sketches.length}枚</p> : null}
            {editable ? (
              <div className="history-copy">
                {COPY_ACTIONS.filter(([kind]) => hasContent(content, kind)).map(([kind, label]) => (
                  <button className="btn btn-chip" key={kind} onClick={() => onCopy(kind, encounter)} type="button">{label}を複写</button>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function hasContent(content, kind) {
  if (kind === "findings") return ["od", "os"].some((side) => Object.values(content.findings?.[side] || {}).some(Boolean));
  if (kind === "prescriptions") return (content.prescriptions || []).length > 0;
  if (kind === "plan") return Boolean(content.plan || content.assessment);
  if (kind === "sketches") return (content.sketches || []).length > 0;
  return false;
}

// 確定前のチェック。止まる理由（赤）と、確認を促す注意（黄）を並べる。
export function ReadinessPanel({ readiness }) {
  if (!readiness.blockers.length && !readiness.warnings.length) {
    return <p className="readiness is-ok">確定できる状態です。</p>;
  }
  return (
    <ul className="readiness">
      {readiness.blockers.map((item, index) => <li className="is-blocker" key={`b${index}`}>{item.message}</li>)}
      {readiness.warnings.map((item, index) => <li className="is-warning" key={`w${index}`}>{item.message}</li>)}
    </ul>
  );
}

// 右列の「候補」: よく使う薬剤を1クリックで処方に追加する。
export function CandidatesPanel({ drugPresets, editable, onAddPrescription }) {
  if (!drugPresets.length) return <p className="empty">設定画面で「よく使う薬剤」を登録すると、ここから追加できます。</p>;
  return (
    <ul className="candidate-buttons">
      {drugPresets.map((preset) => (
        <li key={preset.presetId}>
          <button className="candidate-button" disabled={!editable} onClick={() => onAddPrescription(preset)} type="button">
            <span>{preset.name}</span>
            <span className="muted small">{preset.defaultTimesPerDay ? `1日${preset.defaultTimesPerDay}回` : ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// 右列の「候補」: セット（処方・オーダー・方針の組み合わせ）と定型文。
export function SetsAndPhrasesPanel({ orderSets, phrases, editable, onApplySet, onInsertPhrase }) {
  const activeSets = orderSets.filter((item) => item.active !== false);
  const activePhrases = phrases.filter((item) => item.active !== false);
  const groups = Object.entries(PHRASE_TARGET_LABELS)
    .map(([target, label]) => [target, label, activePhrases.filter((item) => item.target === target)])
    .filter(([, , items]) => items.length);
  return (
    <>
      <section className="panel">
        <h2>セット</h2>
        {activeSets.length === 0 ? <p className="empty">設定画面でセットを登録すると、ここから一括で追加できます。</p> : (
          <ul className="candidate-buttons">
            {activeSets.map((item) => (
              <li key={item.setId}>
                <button className="candidate-button" disabled={!editable} onClick={() => onApplySet(item)} type="button">
                  <span>{item.name}</span>
                  <span className="muted small">処方{item.prescriptions.length}・検査{item.orders.length}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>定型文</h2>
        {groups.length === 0 ? <p className="empty">設定画面で定型文を登録できます。</p> : groups.map(([target, label, items]) => (
          <div className="phrase-group" key={target}>
            <h3>{label}</h3>
            {items.map((item) => (
              <div className="phrase-row" key={item.phraseId}>
                <span className="phrase-text" title={item.text}>{item.label || item.text}</span>
                {target.startsWith("findings.") ? (
                  <span className="phrase-actions">
                    <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "od")} type="button">右</button>
                    <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "os")} type="button">左</button>
                    <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "both")} type="button">両</button>
                  </span>
                ) : (
                  <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item)} type="button">挿入</button>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>
    </>
  );
}
