import { EncounterEditor } from "../../../components/encounter-editor";

export const metadata = { title: "カルテ" };

export default async function EncounterPage({ params }) {
  const { id } = await params;
  return <EncounterEditor encounterId={id} />;
}
