import { ImageCompare } from "../../../../components/image-compare";

export default async function PatientImagesPage({ params }) {
  const { id } = await params;
  return <ImageCompare patientId={id} />;
}
