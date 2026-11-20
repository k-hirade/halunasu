import { ImageCompare } from "../../../../components/image-compare";

export const metadata = { title: "画像" };

export default async function PatientImagesPage({ params }) {
  const { id } = await params;
  return <ImageCompare patientId={id} />;
}
