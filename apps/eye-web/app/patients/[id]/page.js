import { PatientChart } from "../../../components/patient-chart";

export default async function PatientPage({ params }) {
  const { id } = await params;
  return <PatientChart patientId={id} />;
}
