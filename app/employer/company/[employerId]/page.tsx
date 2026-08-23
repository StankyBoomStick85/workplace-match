import { EmployerCompanyProfile } from "@/components/EmployerCompanyProfileForm";

export default function EmployerCompanyProfilePage({ params }: { params: { employerId: string } }) {
  return <EmployerCompanyProfile employerId={params.employerId} />;
}
