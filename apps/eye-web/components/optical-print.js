"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { evaluateOpticalPrescription } from "@halunasu/eye-core";
import { useEyeApi } from "./eye-api";
import { facilityInfo, pickFacility, PrintMessage, PrintShell, readStoredPaper, storePaper, VersionSelect } from "./print-shell";
import { addDays, ageOn, formatDate, formatDateTime } from "../lib/format";

const PAPER_KEY = "halunasu-eye-optical-paper";
const VALID_DAY_CHOICES = [5, 10, 30];

// 眼鏡処方箋（日本眼科医会の様式の並び）・コンタクトレンズ指示書の印刷。
// 選択肢は ■（選択）/ □（未選択）で表し、値のない欄は手書きできるよう空欄のままにする。
// 医師名は確定した医師（finalizedBy）だけを印字する。未確定なら空欄。
export function OpticalPrint({ encounterId }) {
  const api = useEyeApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const versionNumber = searchParams.get("version") || "";
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [paper, setPaper] = useState("A4");

  useEffect(() => { setPaper(readStoredPaper(PAPER_KEY)); }, []);

  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    (async () => {
      const [detail, bootstrap] = await Promise.all([
        api(`/v1/eye/encounters/${encounterId}`),
        api("/v1/eye/bootstrap").catch(() => ({ facilities: [] }))
      ]);
      const base = { encounter: detail.encounter, versions: detail.versions || [], facility: pickFacility(bootstrap.facilities) };
      if (versionNumber) {
        const { version } = await api(`/v1/eye/encounters/${encounterId}/versions/${Number(versionNumber)}`);
        return { ...base, optical: version.content?.optical || {}, encounterDate: version.encounterDate, finalized: { version: version.version, finalizedAt: version.finalizedAt, finalizedBy: version.finalizedBy } };
      }
      const { encounter } = detail;
      return {
        ...base,
        optical: encounter.content?.optical || {},
        encounterDate: encounter.encounterDate,
        finalized: encounter.status === "finalized" ? { version: encounter.versionCount, finalizedAt: encounter.finalizedAt, finalizedBy: encounter.finalizedBy } : null
      };
    })()
      .then((next) => active && setData(next))
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [api, encounterId, versionNumber]);

  const back = { backHref: `/encounters/${encounterId}`, backLabel: "カルテに戻る" };
  if (error) return <PrintMessage {...back}><p className="alert alert-danger" role="alert">{error}</p></PrintMessage>;
  if (!data) return <PrintMessage {...back}><p className="loading">読み込み中…</p></PrintMessage>;

  const { encounter, optical, finalized, facility } = data;
  const type = optical.type || "";
  const contact = type === "contact";
  const problems = evaluateOpticalPrescription({ ...optical, issue: true });
  // 未確定・未発行・不備あり・種類未選択は、処方箋として使われないよう透かしを入れる
  const draft = !finalized || !optical.issue || problems.length > 0 || !type;
  const title = type === "contact" ? "コンタクトレンズ指示書" : type === "glasses" ? "眼鏡処方箋" : "眼鏡処方箋 / コンタクトレンズ指示書（種類未選択）";
  const patient = encounter.patientSnapshot || {};
  const reasons = [
    !finalized ? "カルテが未確定" : "",
    !optical.issue ? "「発行する」になっていません" : "",
    ...problems.map((item) => item.message.replace(/。$/u, ""))
  ].filter(Boolean);

  function selectVersion(value) {
    router.replace(value ? `${pathname}?version=${value}` : pathname);
  }
  function changePaper(value) {
    setPaper(value);
    storePaper(PAPER_KEY, value);
  }

  const alerts = reasons.length ? (
    <p className="print-alert is-draft">
      <strong>{finalized ? "発行前" : "下書き（未確定）"}</strong>：{reasons.join(" / ")}。紙には「下書き・未確定」の透かしが入ります。
      <Link href={`/encounters/${encounterId}`}>カルテで直す →</Link>
    </p>
  ) : null;

  const sheetProps = { optical, patient, encounterDate: data.encounterDate, finalized, info: facilityInfo(facility), title };
  return (
    <PrintShell
      {...back}
      alerts={alerts}
      controls={<VersionSelect latestLabel={encounter.status === "finalized" ? `最新（確定 v${encounter.versionCount}）` : "最新（下書き）"} onChange={selectVersion} value={versionNumber} versions={data.versions} />}
      draft={draft}
      margin={paper === "A5" ? "10mm" : "15mm"}
      onPaperChange={changePaper}
      paper={paper}
      paperOptions={["A4", "A5"]}
      sheetClassName="sheet-rx"
      statusLabel={finalized ? `確定 v${finalized.version}（${formatDateTime(finalized.finalizedAt)}）` : "下書き（未確定）"}
      subject={`${patient.displayName || ""} 様`}
      title={title}
    >
      {contact ? <ContactSheet {...sheetProps} /> : <GlassesSheet {...sheetProps} />}
    </PrintShell>
  );
}

function GlassesSheet({ optical, patient, encounterDate, finalized, info, title }) {
  const typed = Boolean(optical.type);
  const purpose = typed ? optical.purpose : "";
  const focus = { far: "single", near: "single", middle: "single", bifocal: "bifocal", progressive: "progressive" }[purpose] || "";
  return (
    <div className="rx-sheet">
      <p className="rx-no">No. <span className="rx-blank rx-blank-short" /></p>
      <h1 className="rx-title">{title}</h1>
      <PatientLine encounterDate={encounterDate} patient={patient} />

      <h2 className="rx-sec">Ⅰ. レンズ種類</h2>
      <table className="rx-form">
        <tbody>
          <tr><th scope="row">素材</th><td colSpan={3}><Choice>ガラス</Choice><Choice>プラスチック</Choice><span className="rx-paren">（<span className="rx-blank" />）</span></td></tr>
          <tr>
            <th scope="row">種類</th>
            <td colSpan={3}>
              <Choice on={focus === "single"}>単焦点</Choice><Choice on={focus === "bifocal"}>二重焦点</Choice><Choice>三重焦点</Choice><Choice on={focus === "progressive"}>累進焦点</Choice>
              <span className="rx-paren">（<span className="rx-blank" />）</span>
            </td>
          </tr>
          <tr><th scope="row">コート</th><td><span className="rx-paren">（<span className="rx-blank" />）</span></td><th scope="row">カラー</th><td><span className="rx-paren">（<span className="rx-blank" />）</span></td></tr>
        </tbody>
      </table>

      <h2 className="rx-sec">Ⅱ. レンズ値</h2>
      <table className="rx-values">
        <thead>
          <tr><th scope="col" /><th scope="col">球面</th><th scope="col">円柱</th><th scope="col">軸度</th><th scope="col">加入度</th><th scope="col">プリズム</th><th scope="col">基底方向</th><th scope="col">瞳孔距離</th></tr>
        </thead>
        <tbody>
          {["od", "os"].map((side) => {
            const value = optical[side] || {};
            return (
              <tr key={side}>
                <th scope="row">{side === "od" ? "右" : "左"}</th>
                <td><Value unit="D">{diopter(value.sphere)}</Value></td>
                <td><Value unit="D">{diopter(value.cylinder)}</Value></td>
                <td><Value unit="°">{Number.isFinite(value.axis) ? String(value.axis) : ""}</Value></td>
                <td><Value unit="D">{diopter(value.add)}</Value></td>
                <td><Value unit="△">{Number.isFinite(value.prism) ? String(value.prism) : ""}</Value></td>
                <td className="rx-text">{value.base || ""}</td>
                {side === "od" ? <td className="rx-pd" rowSpan={2}><Value unit="mm">{Number.isFinite(optical.pd) ? String(optical.pd) : ""}</Value></td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="rx-sec">Ⅲ. 用法</h2>
      <table className="rx-form">
        <tbody>
          <tr>
            <th scope="row">装用目的</th>
            <td>
              <Choice on={purpose === "far"}>遠用</Choice><Choice on={purpose === "near"}>近用</Choice><Choice on={purpose === "progressive" || purpose === "bifocal"}>遠近両用</Choice>
              {purpose === "middle" ? <span className="rx-paren">（中間）</span> : null}
            </td>
          </tr>
          <tr><th scope="row">装用方法</th><td><Choice>常時</Choice><Choice>必要時</Choice><span className="rx-paren">（<span className="rx-blank" />）</span></td></tr>
        </tbody>
      </table>

      <ValidLine encounterDate={encounterDate} validDays={optical.validDays} />
      <div className="rx-line">
        <span className="rx-line-label">Ⅴ. その他</span>
        <ol className="rx-fixed"><li>頂間距離は12mmとする。</li><li>多焦点レンズの瞳孔間距離は遠用を基準とする。</li></ol>
      </div>
      <Remarks optical={optical} />
      <Signature encounterDate={encounterDate} finalized={finalized} info={info} />
      <p className="rx-caution">（注）眼鏡が出来ましたら、検査のため一度ご自身でご持参ください。</p>
    </div>
  );
}

function ContactSheet({ optical, patient, encounterDate, finalized, info, title }) {
  return (
    <div className="rx-sheet">
      <p className="rx-no">No. <span className="rx-blank rx-blank-short" /></p>
      <h1 className="rx-title">{title}</h1>
      <PatientLine encounterDate={encounterDate} patient={patient} />
      <table className="rx-values rx-values-cl">
        <thead>
          <tr><th scope="col" /><th scope="col">製品名</th><th scope="col">BC</th><th scope="col">度数（S）</th><th scope="col">CYL</th><th scope="col">AX</th><th scope="col">DIA</th></tr>
        </thead>
        <tbody>
          {["od", "os"].map((side) => {
            const value = optical[side] || {};
            return (
              <tr key={side}>
                <th scope="row">{side === "od" ? "右" : "左"}</th>
                <td className="rx-text">{value.product || ""}</td>
                <td><Value unit="mm">{Number.isFinite(value.bc) ? value.bc.toFixed(2) : ""}</Value></td>
                <td><Value unit="D">{diopter(value.sphere)}</Value></td>
                <td><Value unit="D">{diopter(value.cylinder)}</Value></td>
                <td><Value unit="°">{Number.isFinite(value.axis) ? String(value.axis) : ""}</Value></td>
                <td><Value unit="mm">{Number.isFinite(value.dia) ? value.dia.toFixed(1) : ""}</Value></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <table className="rx-form">
        <tbody>
          <tr><th scope="row">装用方法</th><td><Choice>終日</Choice><Choice>時間</Choice><span className="rx-paren">（<span className="rx-blank" />）</span></td></tr>
          <tr><th scope="row">交換周期</th><td><span className="rx-paren">（<span className="rx-blank" />）</span></td></tr>
        </tbody>
      </table>
      <ValidLine encounterDate={encounterDate} validDays={optical.validDays} />
      <Remarks optical={optical} />
      <Signature encounterDate={encounterDate} finalized={finalized} info={info} />
      <p className="rx-caution">（注）定期検査を受けてください。異常があれば装用を中止し、受診してください。</p>
    </div>
  );
}

function PatientLine({ patient, encounterDate }) {
  const age = ageOn(patient.birthDate, encounterDate);
  return (
    <p className="rx-patient">
      <span className="rx-field"><span className="rx-label">氏名</span><strong>{patient.displayName}</strong> 様{patient.displayNameKana ? <span className="rx-kana">（{patient.displayNameKana}）</span> : null}</span>
      <span className="rx-field"><span className="rx-label">年齢</span>{age === null ? <span className="rx-blank rx-blank-short" /> : age} 歳</span>
      <span className="rx-field"><Choice on={patient.sex === "male"}>男</Choice><Choice on={patient.sex === "female"}>女</Choice></span>
    </p>
  );
}

function ValidLine({ validDays, encounterDate }) {
  const preset = VALID_DAY_CHOICES.includes(validDays);
  return (
    <p className="rx-line">
      <span className="rx-line-label">Ⅳ. 有効期間</span>
      <span>
        処方箋発行の日より{" "}
        {Number.isFinite(validDays) && !preset ? <strong>{validDays}</strong> : VALID_DAY_CHOICES.map((days) => <Choice key={days} on={validDays === days}>{days}</Choice>)}
        {" "}日
        {Number.isFinite(validDays) && encounterDate ? <span className="rx-until">（{formatDate(addDays(encounterDate, validDays))} まで）</span> : null}
      </span>
    </p>
  );
}

function Remarks({ optical }) {
  const va = ["od", "os"].map((side) => optical[side]?.va ? `${side === "od" ? "R" : "L"} ${optical[side].va}` : "").filter(Boolean).join(" / ");
  return (
    <div className="rx-line rx-remarks">
      <span className="rx-line-label">Ⅵ. 特記</span>
      <div>
        {va ? <p className="rx-va">矯正視力 {va}</p> : null}
        {optical.note ? <p className="pre">{optical.note}</p> : null}
        {!va && !optical.note ? <span className="rx-blank rx-blank-wide" /> : null}
      </div>
    </div>
  );
}

function Signature({ encounterDate, finalized, info }) {
  const [year, month, day] = (encounterDate || "").split("-").map(Number);
  return (
    <div className="rx-sign">
      <p className="rx-date">{year ? `${year} 年 ${month} 月 ${day} 日` : "　　年　　月　　日"}</p>
      <dl>
        <div><dt>医療機関</dt><dd>{info.name}</dd></div>
        <div><dt>所在地</dt><dd>{[info.postalCode ? `〒${info.postalCode}` : "", info.address].filter(Boolean).join(" ")}{info.phone ? `　TEL ${info.phone}` : ""}</dd></div>
        <div><dt>医師名</dt><dd className="rx-sign-name">{finalized?.finalizedBy?.displayName || ""}<span aria-label="押印欄" className="rx-seal">印</span></dd></div>
      </dl>
    </div>
  );
}

function Choice({ on = false, children }) {
  return <span className={`rx-choice${on ? " is-on" : ""}`}>{on ? "■" : "□"}{children}</span>;
}

function Value({ unit, children }) {
  return <span className="rx-value"><span className="rx-num">{children}</span><span className="rx-unit">{unit}</span></span>;
}

function diopter(value) {
  if (!Number.isFinite(value)) return "";
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}
