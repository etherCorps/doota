<script>
    import {
        Html,
        Head,
        Body,
        Preview,
        Container,
        Section,
        Text,
        Button,
        Row,
    } from "@better-svelte-email/components";

    let { verificationLink } = $props();
</script>

<Html class="px-2 justify-between items-center min-h-screen">
    <Head />
    <Body class="bg-zinc-100 text-zinc-900 antialiased dark:bg-zinc-900 dark:text-zinc-100">
        <Preview preview="Verification Email" />
        <Container class="m-8 mx-auto max-w-lg rounded-2xl bg-white p-8">
            <Section class="mx-auto text-center">
                <Text class="text-2xl font-bold text-zinc-900"
                    >Verify your email</Text
                >
                <Text class="mt-3 text-zinc-600">
                    Please click the button below to verify your email address
                    and complete the registration process.
                </Text>
                <Row class="mt-6">
                    <Button
                        href={verificationLink}
                        pX={24}
                        pY={14}
                        class="mr-2 rounded-lg bg-blue-600 text-white"
                    >
                        Confirm my email
                    </Button>
                </Row>
            </Section>
        </Container>
    </Body>
</Html>
