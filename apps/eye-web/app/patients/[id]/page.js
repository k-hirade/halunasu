import { PatientChart } from "../../../components/patient-chart";

export const metadata = { title: "患者" };

export default async function PatientPage({ params }) {
  const { id } = await params;
  return <PatientChart patientId={id} />;
}
