import { ExamWorkbench } from "../../../../components/exam-workbench";

export const metadata = { title: "検査入力" };

export default async function EncounterExamPage({ params }) {
  const { id } = await params;
  return <ExamWorkbench encounterId={id} />;
}
