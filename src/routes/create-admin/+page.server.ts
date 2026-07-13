export const load = async ({ platform }) => {
  // const response = await platform?.env.EMAIL_SENDER.send({
  //   to: "meenashivam823@gmail.com",
  //   from: { name: "Ethercorps.io", email: "welcome@ethercorps.io" },
  //   subject: "Welcome to our service!",
  //   html: "<h1>Welcome!</h1><p>Thanks for signing up.</p>",
  //   text: "Welcome! Thanks for signing up.",
  // });
  // console.log(response?.messageId)
  return {
    title: "Create Admin",
    description: "Create an admin account for the application.",
  };
};
